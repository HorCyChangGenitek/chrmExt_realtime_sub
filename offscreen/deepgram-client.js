const OPEN_TIMEOUT_MS = 10000;
const STABLE_CONNECTION_MS = 10000;
const MAX_QUEUED_FRAMES = 20;

export class DeepgramClient {
    constructor(config, callbacks = {}) {
        this.config = config;
        this.callbacks = callbacks;
        this.socket = null;
        this.intentionalClose = false;
        this.reconnectAttempts = 0;
        this.reconnectTimer = null;
        this.stableTimer = null;
        this.flushTimer = null;
        this.flushingQueue = false;
        this.audioQueue = [];
        this.connectedAt = 0;
        this.fluxTurnState = this.createFluxTurnState();
        this.flushIntervalMs = Math.max(
            20,
            Math.round((this.config.audioFrameMs || 100) * 0.8)
        );
    }

    async connect() {
        this.validateConfig();
        this.intentionalClose = false;
        let lastError = null;
        const maxAttempts = Math.max(0, this.config.maxReconnectAttempts || 0);

        for (let attempt = 0; attempt <= maxAttempts; attempt += 1) {
            try {
                await this.openOnce();
                return;
            } catch (error) {
                lastError = error;
                if (attempt < maxAttempts) {
                    const delayMs = this.getReconnectDelay(attempt + 1);
                    this.callbacks.onStatus?.(
                        `Reconnect ${attempt + 1}/${maxAttempts} in ${delayMs} ms`
                    );
                    await delay(delayMs);
                }
            }
        }
        throw lastError || new Error("Deepgram WebSocket connection failed.");
    }

    sendAudio(buffer) {
        if (!(buffer instanceof ArrayBuffer) || buffer.byteLength === 0) {
            return;
        }
        if (this.socket?.readyState === WebSocket.OPEN && !this.flushingQueue) {
            this.socket.send(buffer);
            return;
        }
        if (!this.intentionalClose) {
            this.audioQueue.push(buffer);
            if (this.audioQueue.length > MAX_QUEUED_FRAMES) {
                this.audioQueue.shift();
            }
        }
    }

    async close() {
        this.intentionalClose = true;
        clearTimeout(this.reconnectTimer);
        clearTimeout(this.stableTimer);
        clearTimeout(this.flushTimer);
        this.reconnectTimer = null;
        this.stableTimer = null;
        this.flushTimer = null;
        this.flushingQueue = false;
        this.audioQueue = [];

        const socket = this.socket;
        this.socket = null;
        if (!socket || socket.readyState === WebSocket.CLOSED) {
            return;
        }

        if (socket.readyState === WebSocket.OPEN) {
            try {
                socket.send(JSON.stringify({ type: "CloseStream" }));
            } catch (error) {
                this.callbacks.onDebug?.("Deepgram CloseStream failed", {
                    message: toMessage(error)
                });
            }
        }
        await delay(150);
        if (socket.readyState === WebSocket.OPEN
            || socket.readyState === WebSocket.CONNECTING) {
            socket.close(1000, "Capture stopped");
        }
    }

    validateConfig() {
        const key = this.config.apiKey?.trim();
        if (!key || key.includes("REPLACE_WITH_")) {
            throw new Error("Deepgram API key is missing. Add it in API Settings.");
        }
        let endpoint;
        try {
            endpoint = new URL(this.config.endpoint);
        } catch {
            throw new Error("Deepgram endpoint is invalid in config.js.");
        }
        if (endpoint.protocol !== "wss:") {
            throw new Error("Deepgram endpoint must use wss.");
        }
        if (!["nova-v1", "flux-v2"].includes(this.config.protocol)) {
            throw new Error("Deepgram protocol must be nova-v1 or flux-v2.");
        }
    }

    openOnce() {
        return new Promise((resolve, reject) => {
            const url = this.buildUrl();
            const socket = new WebSocket(url, ["token", this.config.apiKey]);
            this.socket = socket;
            let opened = false;
            let settled = false;
            let connectionError = null;

            const timeoutId = setTimeout(() => {
                if (!settled) {
                    settled = true;
                    socket.close();
                    reject(new Error("Deepgram WebSocket connection timed out."));
                }
            }, OPEN_TIMEOUT_MS);

            socket.binaryType = "arraybuffer";
            socket.onopen = () => {
                opened = true;
                settled = true;
                clearTimeout(timeoutId);
                this.connectedAt = Date.now();
                this.callbacks.onStatus?.("Connected");
                this.callbacks.onDebug?.("Deepgram WebSocket opened", {
                    model: this.config.model,
                    protocol: this.config.protocol,
                    endpoint: this.config.endpoint
                });
                this.flushAudioQueue();
                clearTimeout(this.stableTimer);
                this.stableTimer = setTimeout(() => {
                    this.reconnectAttempts = 0;
                }, STABLE_CONNECTION_MS);
                resolve();
            };

            socket.onmessage = (event) => {
                this.handleMessage(event.data);
            };

            socket.onerror = () => {
                this.callbacks.onDebug?.("Deepgram WebSocket error", {});
                if (!opened && !settled) {
                    connectionError = new Error(
                        `Deepgram ${this.config.model} WebSocket connection failed. `
                        + "Check the API key, network, endpoint, and model access."
                    );
                }
            };

            socket.onclose = (event) => {
                clearTimeout(timeoutId);
                clearTimeout(this.stableTimer);
                clearTimeout(this.flushTimer);
                this.flushTimer = null;
                this.flushingQueue = false;
                if (this.socket === socket) {
                    this.socket = null;
                }
                this.callbacks.onStatus?.("Disconnected");
                this.callbacks.onDebug?.("Deepgram WebSocket closed", {
                    code: event.code,
                    reason: event.reason || "",
                    clean: event.wasClean
                });

                if (!opened && !settled) {
                    settled = true;
                    reject(this.closeEventToError(event, connectionError));
                    return;
                }
                if (opened && !this.intentionalClose) {
                    this.scheduleReconnect();
                }
            };
        });
    }

    scheduleReconnect() {
        const maxAttempts = Math.max(0, this.config.maxReconnectAttempts || 0);
        if (this.reconnectAttempts >= maxAttempts) {
            this.callbacks.onFatalError?.(
                new Error("Deepgram disconnected and reconnect attempts were exhausted.")
            );
            return;
        }

        this.reconnectAttempts += 1;
        const attempt = this.reconnectAttempts;
        const delayMs = this.getReconnectDelay(attempt);
        this.callbacks.onStatus?.(`Reconnect ${attempt}/${maxAttempts}`);
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = setTimeout(async () => {
            if (this.intentionalClose) {
                return;
            }
            try {
                await this.openOnce();
            } catch (error) {
                this.callbacks.onDebug?.("Deepgram reconnect failed", {
                    attempt,
                    message: toMessage(error)
                });
                this.scheduleReconnect();
            }
        }, delayMs);
    }

    handleMessage(data) {
        if (typeof data !== "string") {
            return;
        }

        let payload;
        try {
            payload = JSON.parse(data);
        } catch (error) {
            this.callbacks.onDebug?.("Deepgram returned invalid JSON", {
                message: toMessage(error)
            });
            return;
        }

        if (payload.type === "Results") {
            this.handleNovaResult(payload);
            return;
        }

        if (payload.type === "TurnInfo") {
            this.handleFluxResult(payload);
            return;
        }

        if (payload.type === "Error" || payload.err_code || payload.error) {
            const message = payload.description
                || payload.message
                || payload.error
                || "Deepgram returned an error.";
            const error = new Error(
                payload.err_code ? `${message} (${payload.err_code})` : message
            );
            this.callbacks.onServerError?.(error);
        }
    }

    flushAudioQueue() {
        if (this.socket?.readyState !== WebSocket.OPEN) {
            return;
        }
        if (this.audioQueue.length === 0) {
            this.flushingQueue = false;
            return;
        }
        this.flushingQueue = true;
        const frame = this.audioQueue.shift();
        this.socket.send(frame);
        this.flushTimer = setTimeout(() => {
            this.flushAudioQueue();
        }, this.flushIntervalMs);
    }

    buildUrl() {
        const url = new URL(this.config.endpoint);
        const commonParams = {
            model: this.config.model || "nova-3",
            encoding: "linear16",
            sample_rate: "16000"
        };
        const profileParams = this.config.protocol === "flux-v2"
            ? {
                eot_threshold: String(this.config.eotThreshold ?? 0.7),
                eot_timeout_ms: String(this.config.eotTimeoutMs ?? 800)
            }
            : {
                channels: "1",
                language: this.config.language || "en-US",
                interim_results: "true",
                punctuate: "true",
                smart_format: "true",
                endpointing: "300",
                vad_events: "true"
            };
        const params = { ...commonParams, ...profileParams };
        for (const [key, value] of Object.entries(params)) {
            url.searchParams.set(key, value);
        }
        return url.toString();
    }

    handleNovaResult(payload) {
        const alternative = payload.channel?.alternatives?.[0];
        const text = alternative?.transcript?.trim() || "";
        if (!text) {
            return;
        }
        this.callbacks.onTranscript?.({
            text,
            isFinal: Boolean(payload.is_final),
            speechFinal: Boolean(payload.speech_final),
            start: Number(payload.start) || 0,
            duration: Number(payload.duration) || 0,
            receivedAt: Date.now()
        });
    }

    handleFluxResult(payload) {
        const text = payload.transcript?.trim() || "";
        if (!text) {
            return;
        }

        const turnIndex = Number(payload.turn_index) || 0;
        const isFinal = payload.event === "EndOfTurn";
        if (this.fluxTurnState.turnIndex !== turnIndex) {
            this.fluxTurnState = this.createFluxTurnState(turnIndex);
        }

        const words = normalizeFluxWords(payload.words);
        if (words.length === 0) {
            this.emitFluxTranscript(text, payload, isFinal, false);
            if (isFinal) {
                this.fluxTurnState = this.createFluxTurnState();
            }
            return;
        }

        let remainingWords = words.filter(
            (word) => word.end > this.fluxTurnState.committedThrough + 0.01
        );

        if (!isFinal) {
            remainingWords = this.commitStableFluxSegments(remainingWords, payload);
            if (remainingWords.length > 0) {
                this.emitFluxWords(remainingWords, payload, false, false);
            }
            return;
        }

        if (remainingWords.length > 0) {
            this.emitFluxWords(remainingWords, payload, true, false);
        }
        this.fluxTurnState = this.createFluxTurnState();
    }

    commitStableFluxSegments(words, payload) {
        let remaining = words;
        const maxWords = clampInteger(this.config.maxSegmentWords, 8, 40, 16);
        const minWords = clampInteger(
            this.config.minSegmentWords,
            3,
            maxWords,
            6
        );
        const tailWords = clampInteger(
            this.config.segmentTailWords,
            2,
            maxWords - 1,
            4
        );

        if (remaining.length > tailWords) {
            const stableWordCount = remaining.length - tailWords;
            const searchLimit = Math.min(maxWords, stableWordCount);
            let cutAt = 0;

            for (let index = minWords - 1; index < searchLimit; index += 1) {
                if (endsSentence(remaining[index].word)) {
                    cutAt = index + 1;
                    break;
                }
            }
            if (cutAt === 0 && remaining.length >= maxWords + tailWords) {
                cutAt = maxWords;
            }
            if (cutAt === 0) {
                return remaining;
            }

            const committed = remaining.slice(0, cutAt);
            this.emitFluxWords(committed, payload, true, true);
            this.fluxTurnState.committedThrough = committed.at(-1).end;
            remaining = remaining.slice(cutAt);
        }
        return remaining;
    }

    emitFluxWords(words, payload, isFinal, clientForced) {
        const text = words.map((word) => word.word).join(" ").trim();
        if (!text) {
            return;
        }
        const start = words[0]?.start
            ?? Number(payload.audio_window_start)
            ?? 0;
        const end = words.at(-1)?.end
            ?? Number(payload.audio_window_end)
            ?? start;
        this.callbacks.onTranscript?.({
            text,
            isFinal,
            speechFinal: isFinal,
            start,
            duration: Math.max(0, end - start),
            receivedAt: Date.now(),
            turnIndex: Number(payload.turn_index) || 0,
            fluxEvent: payload.event || "Update",
            detectedLanguages: getDetectedLanguages(payload),
            clientForced
        });
    }

    emitFluxTranscript(text, payload, isFinal, clientForced) {
        const start = Number(payload.audio_window_start) || 0;
        const end = Number(payload.audio_window_end) || start;
        this.callbacks.onTranscript?.({
            text,
            isFinal,
            speechFinal: isFinal,
            start,
            duration: Math.max(0, end - start),
            receivedAt: Date.now(),
            turnIndex: Number(payload.turn_index) || 0,
            fluxEvent: payload.event || "Update",
            detectedLanguages: getDetectedLanguages(payload),
            clientForced
        });
    }

    createFluxTurnState(turnIndex = null) {
        return {
            turnIndex,
            committedThrough: Number.NEGATIVE_INFINITY
        };
    }

    getReconnectDelay(attempt) {
        return Math.min(1000 * (2 ** Math.max(0, attempt - 1)), 8000);
    }

    closeEventToError(event, fallbackError = null) {
        if (event.code === 1008 || event.code === 4401) {
            return new Error("Deepgram rejected the API key or request (authorization failed).");
        }
        if (fallbackError && event.code === 1006 && !event.reason) {
            return fallbackError;
        }
        if (event.code === 4429) {
            return new Error("Deepgram rate limit was reached.");
        }
        const suffix = event.reason ? `: ${event.reason}` : "";
        return new Error(`Deepgram WebSocket closed (${event.code})${suffix}`);
    }
}

function delay(ms) {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}

function toMessage(error) {
    return error instanceof Error ? error.message : String(error);
}

function normalizeFluxWords(words) {
    if (!Array.isArray(words)) {
        return [];
    }
    return words
        .map((word) => ({
            word: String(word?.word || "").trim(),
            start: Number(word?.start),
            end: Number(word?.end)
        }))
        .filter((word) => (
            word.word
            && Number.isFinite(word.start)
            && Number.isFinite(word.end)
        ));
}

function endsSentence(word) {
    return /[.!?。！？]["')\]」』】]*$/.test(word);
}

function getDetectedLanguages(payload) {
    return Array.isArray(payload?.languages)
        ? payload.languages.filter((language) => typeof language === "string")
        : [];
}

function clampInteger(value, minimum, maximum, fallback) {
    const number = Number(value);
    if (!Number.isFinite(number)) {
        return fallback;
    }
    return Math.min(maximum, Math.max(minimum, Math.round(number)));
}
