const OPEN_TIMEOUT_MS = 15000;
const MAX_QUEUED_FRAMES = 30;

export class GeminiTranscribeClient {
    constructor(config, callbacks = {}) {
        this.config = config;
        this.callbacks = callbacks;
        this.socket = null;
        this.ready = false;
        this.intentionalClose = false;
        this.audioQueue = [];
        this.rotationTimer = null;
        this.rotating = false;
        this.plannedCloses = new WeakSet();
        this.resetTurn();
    }

    validateConfig() {
        if (!isConfigured(this.config.apiKey)) {
            throw new Error("Gemini API key is missing. Add it in API Settings.");
        }
        if (!isConfigured(this.config.model)) {
            throw new Error("Gemini Transcribe model is not configured.");
        }
        let endpoint;
        try {
            endpoint = new URL(this.config.endpoint);
        } catch {
            throw new Error("Gemini Live endpoint is invalid in config.js.");
        }
        if (endpoint.protocol !== "wss:") {
            throw new Error("Gemini Live endpoint must use wss.");
        }
    }

    connect() {
        this.validateConfig();
        this.intentionalClose = false;
        return new Promise((resolve, reject) => {
            const url = new URL(this.config.endpoint);
            url.searchParams.set("key", this.config.apiKey);
            const socket = new WebSocket(url.toString());
            this.socket = socket;
            socket.binaryType = "arraybuffer";
            let settled = false;
            const timeoutId = setTimeout(() => {
                if (!settled) {
                    settled = true;
                    socket.close();
                    reject(new Error("Gemini Transcribe setup timed out."));
                }
            }, this.config.timeoutMs || OPEN_TIMEOUT_MS);

            socket.onopen = () => {
                this.callbacks.onStatus?.("Setting up");
                socket.send(JSON.stringify({
                    setup: {
                        model: `models/${this.config.model}`,
                        generationConfig: {
                            responseModalities: ["TEXT"]
                        },
                        inputAudioTranscription: {
                            languageCodes: [],
                            mode: this.config.transcriptionMode || "VERBATIM"
                        }
                    }
                }));
            };
            socket.onmessage = async (event) => {
                const message = await parseMessage(event.data);
                if (!message) {
                    return;
                }
                if (message.setupComplete !== undefined) {
                    this.ready = true;
                    clearTimeout(timeoutId);
                    this.callbacks.onStatus?.("Connected");
                    this.callbacks.onDebug?.("Gemini Transcribe setup complete", {
                        model: this.config.model,
                        automaticLanguageDetection: true,
                        mode: this.config.transcriptionMode || "VERBATIM"
                    });
                    this.scheduleSessionRotation();
                    this.flushAudioQueue();
                    if (!settled) {
                        settled = true;
                        resolve();
                    }
                    return;
                }
                this.handleServerMessage(message);
            };
            socket.onerror = () => {
                this.callbacks.onDebug?.("Gemini Transcribe WebSocket error", {});
            };
            socket.onclose = (event) => {
                clearTimeout(timeoutId);
                const plannedClose = this.plannedCloses.has(socket)
                    || this.intentionalClose;
                const isCurrentSocket = this.socket === socket;
                if (isCurrentSocket) {
                    this.ready = false;
                    this.socket = null;
                }
                if (isCurrentSocket || !plannedClose) {
                    this.callbacks.onStatus?.("Disconnected");
                }
                if (!settled) {
                    settled = true;
                    reject(new Error(
                        `Gemini Transcribe connection failed (${event.code})${event.reason ? `: ${event.reason}` : ""}`
                    ));
                } else if (!plannedClose) {
                    this.callbacks.onFatalError?.(new Error(
                        `Gemini Transcribe disconnected (${event.code})${event.reason ? `: ${event.reason}` : ""}`
                    ));
                }
            };
        });
    }

    sendAudio(buffer) {
        if (!(buffer instanceof ArrayBuffer) || buffer.byteLength === 0) {
            return;
        }
        if (!this.ready || this.socket?.readyState !== WebSocket.OPEN) {
            this.audioQueue.push(buffer);
            if (this.audioQueue.length > MAX_QUEUED_FRAMES) {
                this.audioQueue.shift();
            }
            return;
        }
        this.sendFrame(buffer);
    }

    async close() {
        this.intentionalClose = true;
        clearTimeout(this.rotationTimer);
        this.rotationTimer = null;
        this.ready = false;
        this.audioQueue = [];
        const socket = this.socket;
        this.socket = null;
        if (socket && socket.readyState < WebSocket.CLOSING) {
            this.plannedCloses.add(socket);
            socket.close(1000, "Capture stopped");
        }
        this.resetTurn();
    }

    handleServerMessage(message) {
        if (message.goAway) {
            this.callbacks.onDebug?.("Gemini Transcribe go-away received", message.goAway);
        }
        const content = message.serverContent;
        if (!content) {
            return;
        }

        // Final text is authoritative; a simultaneous interim can contain the next tail.
        const final = normalizeTranscript(content.inputTranscription);
        if (final.text) {
            this.languageCode = final.languageCode || this.languageCode;
            const remaining = this.removeCommittedTranscript(final).text;
            this.interimText = "";
            this.commitFinalSegments(remaining);
        }

        const interim = normalizeTranscript(content.interimInputTranscription);
        if (interim.text) {
            this.languageCode = interim.languageCode || this.languageCode;
            const remaining = this.removeCommittedTranscript(interim).text;
            if (remaining) {
                this.interimText = this.commitStableSegments(remaining);
                if (this.interimText) {
                    this.emitTranscript(this.interimText, false, true);
                }
            }
        }

        if (content.interrupted) {
            this.callbacks.onDebug?.("Gemini Transcribe interrupted", {});
        }
        if (content.turnComplete) {
            if (this.interimText) {
                this.commitFinalSegments(this.interimText);
            }
            this.resetTurn();
        }
    }

    commitStableSegments(text) {
        let remaining = String(text || "").trim();
        while (remaining) {
            const cutAt = findGeminiSegmentCut(remaining, this.config, true);
            if (!cutAt) {
                break;
            }
            this.commitSegment(remaining.slice(0, cutAt), true);
            remaining = remaining.slice(cutAt).trim();
        }
        return remaining;
    }

    commitFinalSegments(text) {
        let remaining = String(text || "").trim();
        while (remaining) {
            const cutAt = findGeminiSegmentCut(remaining, this.config, false);
            if (!cutAt) {
                this.commitSegment(remaining, false);
                break;
            }
            this.commitSegment(remaining.slice(0, cutAt), cutAt < remaining.length);
            remaining = remaining.slice(cutAt).trim();
        }
    }

    commitSegment(text, clientForced) {
        const normalized = String(text || "").trim();
        if (!normalized) {
            return;
        }
        this.emitTranscript(normalized, true, clientForced);
        // Append every emitted segment, including intentional repeated phrases.
        this.committedText = `${this.committedText} ${normalized}`.trim();
    }

    emitTranscript(text, isFinal, clientForced) {
        this.callbacks.onTranscript?.({
            text,
            isFinal,
            speechFinal: isFinal,
            start: 0,
            duration: 0,
            receivedAt: Date.now(),
            detectedLanguages: this.languageCode ? [this.languageCode] : [],
            geminiEvent: isFinal ? "Final" : "Interim",
            clientForced
        });
    }

    removeCommittedTranscript(transcript) {
        return {
            ...transcript,
            text: stripCommittedPrefix(transcript.text, this.committedText)
        };
    }

    sendFrame(buffer) {
        this.socket.send(JSON.stringify({
            realtimeInput: {
                audio: {
                    data: arrayBufferToBase64(buffer),
                    mimeType: "audio/pcm;rate=16000"
                }
            }
        }));
    }

    flushAudioQueue() {
        const frames = this.audioQueue.splice(0);
        for (const frame of frames) {
            if (!this.ready || this.socket?.readyState !== WebSocket.OPEN) {
                break;
            }
            this.sendFrame(frame);
        }
    }

    scheduleSessionRotation() {
        clearTimeout(this.rotationTimer);
        const rotationMs = clampInteger(
            this.config.sessionRotationMs,
            60000,
            590000,
            570000
        );
        this.rotationTimer = setTimeout(() => {
            void this.rotateSession();
        }, rotationMs);
    }

    async rotateSession() {
        if (this.intentionalClose || this.rotating) {
            return;
        }
        this.rotating = true;
        clearTimeout(this.rotationTimer);
        this.rotationTimer = null;
        if (this.interimText) {
            this.commitFinalSegments(this.interimText);
        }
        this.resetTurn();
        const oldSocket = this.socket;
        this.ready = false;
        if (oldSocket && oldSocket.readyState < WebSocket.CLOSING) {
            this.plannedCloses.add(oldSocket);
            oldSocket.close(1000, "Session rotation");
        }
        this.callbacks.onStatus?.("Rotating session");
        this.callbacks.onDebug?.("Gemini Transcribe session rotation", {});
        try {
            await this.connect();
        } catch (error) {
            this.callbacks.onFatalError?.(error);
        } finally {
            this.rotating = false;
        }
    }

    resetTurn() {
        this.interimText = "";
        this.committedText = "";
        this.languageCode = "";
    }
}

async function parseMessage(data) {
    try {
        if (typeof data === "string") {
            return JSON.parse(data);
        }
        if (data instanceof ArrayBuffer) {
            return JSON.parse(new TextDecoder().decode(data));
        }
        if (typeof Blob !== "undefined" && data instanceof Blob) {
            return JSON.parse(await data.text());
        }
        return null;
    } catch {
        return null;
    }
}

function normalizeTranscript(value) {
    return {
        text: String(value?.text || "").trim(),
        languageCode: String(value?.languageCode || "").trim()
    };
}

function stripCommittedPrefix(text, committed) {
    const incoming = String(text || "").trim();
    const history = transcriptCharacters(committed).text;
    const comparable = transcriptCharacters(incoming);
    if (!incoming || !history) {
        return incoming;
    }
    if (!comparable.text || history.startsWith(comparable.text)) {
        return "";
    }
    if (comparable.text.startsWith(history)) {
        return removeMatchedCharacters(incoming, comparable.ends, history.length);
    }
    const maxOverlap = Math.min(history.length, comparable.text.length);
    for (let length = maxOverlap; length >= 8; length -= 1) {
        if (history.slice(-length) === comparable.text.slice(0, length)) {
            return removeMatchedCharacters(incoming, comparable.ends, length);
        }
    }
    return incoming;
}

function transcriptCharacters(value) {
    let text = "";
    const ends = [];
    const source = String(value || "");
    // Keep source offsets so punctuation/case changes do not shift the remaining tail.
    for (const match of source.matchAll(/[\p{L}\p{N}\p{M}]/gu)) {
        const character = match[0].toLowerCase();
        text += character;
        for (let index = 0; index < character.length; index += 1) {
            ends.push(match.index + match[0].length);
        }
    }
    return { text, ends };
}

function removeMatchedCharacters(source, ends, count) {
    return source.slice(ends[count - 1]).replace(/^[\p{P}\p{Z}\s]+/u, "").trim();
}

function findGeminiSegmentCut(text, config, preserveTail) {
    const normalized = String(text || "").trim();
    if (!normalized) {
        return 0;
    }

    const maxWords = clampInteger(config.maxSegmentWords, 8, 40, 16);
    const tailWords = clampInteger(
        config.segmentTailWords,
        2,
        maxWords - 1,
        4
    );
    const maxChars = clampInteger(config.maxSegmentChars, 40, 500, 100);
    const tailChars = clampInteger(
        config.segmentTailChars,
        8,
        200,
        24
    );
    const words = getWordRanges(normalized);
    const wordMode = words.length > 1
        && !/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}]/u.test(normalized);
    const stableWordCount = Math.max(0, words.length - (preserveTail ? tailWords : 0));
    const stableLimit = !preserveTail ? normalized.length : wordMode
        ? (words[stableWordCount - 1]?.end || 0)
        : Math.max(0, normalized.length - tailChars);
    const wordLimit = wordMode && words.length >= maxWords
        ? words[maxWords - 1].end
        : normalized.length;
    const limit = Math.min(maxChars, wordLimit, stableLimit);
    const sentenceCut = findSentenceCharacterCut(normalized, limit);
    if (sentenceCut) {
        return sentenceCut;
    }
    const lengthReached = stableLimit >= maxChars
        || (wordMode && stableWordCount >= maxWords);
    if (lengthReached) {
        return findPreferredCharacterCut(normalized, limit);
    }
    return 0;
}

function getWordRanges(text) {
    return Array.from(text.matchAll(/\S+/gu), (match) => ({
        text: match[0],
        end: match.index + match[0].length
    }));
}

function findSentenceCharacterCut(text, maximumEnd) {
    const punctuation = /[.!?。！？]+["'”’）)\]」』】]*/gu;
    let match;
    while ((match = punctuation.exec(text))) {
        const end = punctuation.lastIndex;
        if (end > maximumEnd) {
            break;
        }
        // A dot within a word/number is not a sentence boundary (e.g. 3.5).
        if (match[0].startsWith(".") && !/^(?:\s|$)/u.test(text.slice(end))) {
            continue;
        }
        const precedingWord = text.slice(0, match.index).match(/[^\s]+$/u)?.[0] || "";
        if (match[0].startsWith(".")
            && (/^(?:mr|mrs|ms|dr|prof|sr|jr|st|vs|etc)$/iu.test(precedingWord)
                || /^(?:[a-z]\.)*[a-z]$/iu.test(precedingWord))) {
            continue;
        }
        if (end <= maximumEnd) {
            return end;
        }
    }
    return 0;
}

function findPreferredCharacterCut(text, maximumLength) {
    const limit = Math.min(maximumLength, text.length);
    if (limit === text.length || /\s/u.test(text[limit])) {
        return limit;
    }
    const minimumPreferredCut = Math.max(1, limit - 24);
    const safeBoundary = /[\s,，;；:：.!?。！？]/gu;
    let preferredCut = 0;
    let match;
    while ((match = safeBoundary.exec(text)) && match.index < limit) {
        const end = match.index + match[0].length;
        if (end >= minimumPreferredCut && end <= limit) {
            preferredCut = end;
        }
    }
    if (preferredCut) {
        return preferredCut;
    }
    // Fall back to a whole word even when it is far from the character limit.
    const space = text.slice(0, limit + 1).search(/\s+\S*$/u);
    if (space > 0) {
        return space;
    }
    // Do not split a UTF-16 surrogate pair at the hard character limit.
    return /[\uD800-\uDBFF]/u.test(text[limit - 1] || "") ? limit - 1 : limit;
}

function clampInteger(value, minimum, maximum, fallback) {
    const number = Number(value);
    if (!Number.isFinite(number)) {
        return fallback;
    }
    return Math.min(maximum, Math.max(minimum, Math.round(number)));
}

function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = "";
    for (let index = 0; index < bytes.length; index += 1) {
        binary += String.fromCharCode(bytes[index]);
    }
    return btoa(binary);
}

function isConfigured(value) {
    return Boolean(value) && !String(value).includes("REPLACE_WITH_");
}
