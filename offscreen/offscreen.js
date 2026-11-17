import { CONFIG } from "../config.js";
import { DeepgramClient } from "./deepgram-client.js";
import { CustomLlmClient } from "./custom-llm-client.js";
import { GeminiTextClient } from "./gemini-text-client.js";
import { GeminiTranscribeClient } from "./gemini-transcribe-client.js";
import { TranslationScheduler } from "./translation-scheduler.js";

const TARGET_SAMPLE_RATE = 16000;

let pipeline = createEmptyPipeline();
let segmentCounter = 0;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || typeof message.action !== "string") {
        return false;
    }

    if (message.action === "OFFSCREEN_START") {
        startPipeline(
            message.streamId,
            message.tabId,
            message.settings,
            message.providerConfig
        )
            .then(() => sendResponse({ ok: true }))
            .catch((error) => sendResponse({
                ok: false,
                error: toMessage(error)
            }));
        return true;
    }

    if (message.action === "OFFSCREEN_STOP") {
        stopPipeline({ notify: true })
            .then(() => sendResponse({ ok: true }))
            .catch((error) => sendResponse({
                ok: false,
                error: toMessage(error)
            }));
        return true;
    }

    if (message.action === "OFFSCREEN_GET_STATUS") {
        sendResponse({
            ok: true,
            state: pipeline.publicState
        });
        return false;
    }

    if (message.action === "OFFSCREEN_SETTINGS") {
        pipeline.debugMode = Boolean(message.settings?.debugMode);
        if (pipeline.debugMode) {
            emitDebug("Debug mode enabled", {});
        }
        sendResponse({ ok: true });
        return false;
    }

    return false;
});

async function startPipeline(streamId, tabId, settings = {}, providerConfig = {}) {
    if (!streamId || !Number.isInteger(tabId)) {
        throw new Error("The offscreen document received invalid capture parameters.");
    }
    if (pipeline.running || pipeline.starting) {
        throw new Error("The audio pipeline is already active.");
    }

    pipeline = createEmptyPipeline();
    pipeline.debugMode = Boolean(settings.debugMode);
    pipeline.providerConfig = providerConfig;
    pipeline.deepgramProfileId = CONFIG.deepgram.profiles[settings.deepgramProfile]
        ? settings.deepgramProfile
        : CONFIG.deepgram.defaultProfile;
    const speechProfile = CONFIG.deepgram.profiles[pipeline.deepgramProfileId];
    pipeline.isGeminiTranscribe = speechProfile.provider === "gemini-transcribe";
    pipeline.deepgramConfig = pipeline.isGeminiTranscribe
        ? {
            apiKey: providerConfig.geminiApiKey,
            endpoint: CONFIG.gemini.liveEndpoint,
            timeoutMs: CONFIG.gemini.timeoutMs,
            ...speechProfile
        }
        : {
            apiKey: providerConfig.deepgramApiKey,
            maxReconnectAttempts: CONFIG.deepgram.maxReconnectAttempts,
            ...speechProfile
        };
    pipeline.translationProfileId = CONFIG.translation.profiles[
        settings.translationProfile
    ]
        ? settings.translationProfile
        : CONFIG.translation.defaultProfile;
    pipeline.frameSamples = Math.round(
        TARGET_SAMPLE_RATE * (pipeline.deepgramConfig.audioFrameMs / 1000)
    );
    pipeline.starting = true;
    pipeline.tabId = tabId;
    pipeline.publicState = {
        lifecycle: "Capturing",
        deepgram: "Connecting",
        translator: "Not checked",
        error: "",
        capturingTabId: tabId,
        startedAt: Date.now(),
        deepgramProfile: pipeline.deepgramProfileId
    };
    emitState(pipeline.publicState);

    try {
        const translatorClient = createTranslationClient();
        translatorClient.validateConfig();
        pipeline.gemmaClient = translatorClient;
        emitState({ translator: "Ready" });

        pipeline.mediaStream = await getTabMediaStream(streamId);
        if (pipeline.mediaStream.getAudioTracks().length === 0) {
            throw new Error("The captured tab did not provide an audio track.");
        }
        attachTrackListeners(pipeline.mediaStream);

        pipeline.audioContext = await createAudioContext();
        pipeline.sourceNode = pipeline.audioContext.createMediaStreamSource(
            pipeline.mediaStream
        );
        pipeline.sourceNode.connect(pipeline.audioContext.destination);

        await pipeline.audioContext.audioWorklet.addModule(
            chrome.runtime.getURL("offscreen/audio-worklet.js")
        );
        pipeline.workletNode = new AudioWorkletNode(
            pipeline.audioContext,
            "pcm-resampler",
            {
                processorOptions: {
                    targetSampleRate: TARGET_SAMPLE_RATE,
                    frameSamples: pipeline.frameSamples
                }
            }
        );
        pipeline.silentGainNode = pipeline.audioContext.createGain();
        pipeline.silentGainNode.gain.value = 0;
        pipeline.workletNode.connect(pipeline.silentGainNode);
        pipeline.silentGainNode.connect(pipeline.audioContext.destination);
        pipeline.workletNode.port.onmessage = handleWorkletMessage;

        emitDebug("Audio pipeline initialized", {
            sourceSampleRate: pipeline.audioContext.sampleRate,
            targetSampleRate: TARGET_SAMPLE_RATE,
            frameSamples: pipeline.frameSamples,
            frameMs: pipeline.deepgramConfig.audioFrameMs,
            deepgramProfile: pipeline.deepgramProfileId,
            trackLabel: pipeline.mediaStream.getAudioTracks()[0]?.label || "tab audio"
        });

        pipeline.deepgramClient = createSpeechClient();
        await pipeline.deepgramClient.connect();
        emitState({
            lifecycle: pipeline.isGeminiTranscribe
                ? "Gemini Transcribe Connected"
                : "Deepgram Connected",
            deepgram: "Connected",
            error: ""
        });

        pipeline.translationScheduler = createTranslationScheduler(
            translatorClient
        );
        pipeline.sourceNode.connect(pipeline.workletNode);
        pipeline.running = true;
        pipeline.starting = false;
        pipeline.bytesSentThisSecond = 0;
        pipeline.bytesTimer = setInterval(reportAudioStatistics, 1000);
        emitState({
            lifecycle: "Capturing",
            deepgram: "Connected",
            translator: "Ready"
        });
    } catch (error) {
        pipeline.starting = false;
        await reportFatalError(error);
        throw error;
    }
}

async function stopPipeline(options = {}) {
    const notify = options.notify !== false;
    const preservedError = options.preserveError
        ? pipeline.publicState.error
        : "";

    clearInterval(pipeline.bytesTimer);
    pipeline.bytesTimer = null;
    pipeline.translationScheduler?.stop();
    pipeline.translationScheduler = null;

    if (pipeline.workletNode) {
        pipeline.workletNode.port.onmessage = null;
        safeDisconnect(pipeline.workletNode);
    }
    safeDisconnect(pipeline.silentGainNode);
    safeDisconnect(pipeline.sourceNode);

    if (pipeline.deepgramClient) {
        await pipeline.deepgramClient.close().catch((error) => {
            emitDebug("Speech connection close failed", { message: toMessage(error) });
        });
    }

    if (pipeline.mediaStream) {
        for (const track of pipeline.mediaStream.getTracks()) {
            track.onended = null;
            track.stop();
        }
    }

    if (pipeline.audioContext
        && pipeline.audioContext.state !== "closed") {
        await pipeline.audioContext.close().catch((error) => {
            emitDebug("AudioContext close failed", { message: toMessage(error) });
        });
    }

    const errorState = options.preserveError;
    pipeline = createEmptyPipeline();
    pipeline.publicState = {
        lifecycle: errorState ? "Error" : "Stopped",
        deepgram: "Disconnected",
        translator: "Disconnected",
        error: preservedError,
        capturingTabId: null,
        startedAt: null
    };
    if (notify) {
        emitState(pipeline.publicState);
    }
}

function createSpeechClient() {
    if (pipeline.isGeminiTranscribe) {
        return new GeminiTranscribeClient(pipeline.deepgramConfig, {
            onStatus: (status) => emitState({ deepgram: status }),
            onTranscript: (segment) => handleTranscript(segment),
            onFatalError: (error) => void reportFatalError(error),
            onDebug: (label, data) => emitDebug(label, data)
        });
    }
    return new DeepgramClient(pipeline.deepgramConfig, {
        onStatus: (status) => {
            emitState({ deepgram: status });
        },
        onTranscript: (segment) => {
            handleTranscript(segment);
        },
        onServerError: (error) => {
            void reportFatalError(error);
        },
        onFatalError: (error) => {
            void reportFatalError(error);
        },
        onDebug: (label, data) => {
            emitDebug(label, data);
        }
    });
}

function createTranslationClient() {
    const profile = CONFIG.translation.profiles[pipeline.translationProfileId];
    const label = profile.label || pipeline.translationProfileId;
    const callbacks = {
        onRequest: (text) => {
            emitState({
                lifecycle: "Translating",
                translator: "Translating",
                error: ""
            });
            emitDebug(`${label} request`, {
                sourceText: text
            });
        },
        onResponse: (translation, elapsedMs) => {
            emitState({
                lifecycle: "Translator Connected",
                translator: "Connected",
                error: ""
            });
            emitDebug(`${label} response`, {
                translation,
                elapsedMs
            });
        }
    };
    if (profile.provider === "gemini") {
        return new GeminiTextClient({
            ...CONFIG.gemini,
            ...profile,
            apiKey: pipeline.providerConfig.geminiApiKey,
            systemPrompt: CONFIG.customLlm.systemPrompt,
            maxTokens: CONFIG.customLlm.maxTokens
        }, callbacks);
    }
    const customLlm = pipeline.providerConfig.customLlm || {};
    return new CustomLlmClient({
        ...CONFIG.customLlm,
        ...customLlm
    }, callbacks);
}

function createTranslationScheduler(translatorClient) {
    return new TranslationScheduler({
        gemmaClient: translatorClient,
        debounceMs: CONFIG.translation.debounceMs,
        interimCadenceMs: CONFIG.translation.interimCadenceMs,
        callbacks: {
            onInterimEnglish: (text, metadata) => {
                emitSubtitle({
                    action: "INTERIM_ENGLISH",
                    text,
                    metadata
                });
            },
            onInterimTranslation: (text, metadata) => {
                emitSubtitle({
                    action: "INTERIM_TRANSLATION",
                    text,
                    metadata
                });
                emitLatency(metadata);
            },
            onFinalEnglish: (segment, metadata) => {
                emitSubtitle({
                    action: "FINAL_SEGMENT",
                    segment,
                    metadata
                });
            },
            onFinalTranslation: (segment, metadata = {}) => {
                emitSubtitle({
                    action: "FINAL_TRANSLATION",
                    segment,
                    metadata
                });
                emitLatency(metadata);
            },
            onTranslating: (translating) => {
                if (translating) {
                    emitState({
                        lifecycle: "Translating",
                        translator: "Translating"
                    });
                } else if (pipeline.running) {
                    emitState({
                        lifecycle: "Capturing",
                        translator: pipeline.publicState.translator === "Connected"
                            ? "Connected"
                            : "Ready"
                    });
                }
            },
            onTranslationError: (error, details) => {
                emitState({
                    lifecycle: "Error",
                    translator: "Error",
                    error: toMessage(error)
                });
                emitDebug("Translation error", {
                    ...details,
                    message: toMessage(error)
                });
            },
            onDebug: (label, data) => {
                emitDebug(label, data);
            }
        }
    });
}

function handleTranscript(segment) {
    const speechProvider = pipeline.isGeminiTranscribe
        ? "Gemini Transcribe"
        : "Deepgram";
    emitDebug(
        segment.isFinal
            ? `${speechProvider} final transcript`
            : `${speechProvider} interim transcript`,
        {
            text: segment.text,
            receivedAt: segment.receivedAt,
            start: segment.start,
            duration: segment.duration,
            speechFinal: segment.speechFinal,
            detectedLanguages: segment.detectedLanguages || []
        }
    );

    if (segment.isFinal) {
        segmentCounter += 1;
        pipeline.translationScheduler?.handleFinal(
            {
                id: `segment-${Date.now()}-${segmentCounter}`,
                english: segment.text,
                chinese: "",
                status: "translating"
            },
            segment
        );
        return;
    }
    pipeline.translationScheduler?.handleInterim(segment.text, segment);
}

function handleWorkletMessage(event) {
    const message = event.data;
    if (message?.type === "PCM_FRAME" && message.buffer instanceof ArrayBuffer) {
        pipeline.deepgramClient?.sendAudio(message.buffer);
        pipeline.bytesSentThisSecond += message.buffer.byteLength;
        pipeline.totalBytesSent += message.buffer.byteLength;
        return;
    }
    if (message?.type === "AUDIO_LEVEL") {
        pipeline.lastAudioLevel = {
            rms: round(message.rms, 5),
            peak: round(message.peak, 5)
        };
    }
}

function reportAudioStatistics() {
    emitDebug("Audio statistics", {
        sourceSampleRate: pipeline.audioContext?.sampleRate || 0,
        targetSampleRate: TARGET_SAMPLE_RATE,
        bytesPerSecond: pipeline.bytesSentThisSecond,
        totalBytesSent: pipeline.totalBytesSent,
        rms: pipeline.lastAudioLevel.rms,
        peak: pipeline.lastAudioLevel.peak,
        websocketState: getWebSocketState(pipeline.deepgramClient?.socket)
    });
    pipeline.bytesSentThisSecond = 0;
}

async function getTabMediaStream(streamId) {
    try {
        return await navigator.mediaDevices.getUserMedia({
            audio: {
                mandatory: {
                    chromeMediaSource: "tab",
                    chromeMediaSourceId: streamId
                }
            },
            video: false
        });
    } catch (error) {
        throw new Error(`MediaStream creation failed: ${toMessage(error)}`);
    }
}

async function createAudioContext() {
    try {
        const context = new AudioContext({ latencyHint: "interactive" });
        if (context.state === "suspended") {
            await context.resume();
        }
        return context;
    } catch (error) {
        throw new Error(`AudioContext creation failed: ${toMessage(error)}`);
    }
}

function attachTrackListeners(stream) {
    for (const track of stream.getTracks()) {
        track.onended = () => {
            if (pipeline.running || pipeline.starting) {
                void reportFatalError(
                    new Error("The captured tab audio track ended unexpectedly.")
                );
            }
        };
    }
}

async function reportFatalError(error) {
    if (pipeline.stopping) {
        return;
    }
    pipeline.stopping = true;
    const message = toMessage(error);
    console.warn("Pipeline stopped after a handled error:", error);
    pipeline.publicState.error = message;
    emitEvent({
        type: "ERROR",
        message
    });
    emitState({
        lifecycle: "Error",
        error: message
    });
    await stopPipeline({
        notify: true,
        preserveError: true
    });
}

function emitLatency(metadata) {
    if (!metadata?.receivedAt || !metadata?.elapsedMs) {
        return;
    }
    emitDebug("Translation latency", {
        translationMs: metadata.elapsedMs,
        estimatedEndToEndMs: Math.max(0, Date.now() - metadata.receivedAt)
    });
}

function emitSubtitle(payload) {
    emitEvent({
        type: "SUBTITLE",
        payload
    });
}

function emitState(patch) {
    pipeline.publicState = {
        ...pipeline.publicState,
        ...patch
    };
    emitEvent({
        type: "STATE",
        patch
    });
}

function emitDebug(label, data) {
    if (!pipeline.debugMode) {
        return;
    }
    const entry = {
        label,
        at: Date.now(),
        ...(data || {})
    };
    console.debug(`[Realtime Subtitles] ${label}`, data || "");
    emitEvent({
        type: "DEBUG",
        data: {
            lastEvent: entry
        }
    });
}

function emitEvent(event) {
    chrome.runtime.sendMessage({
        action: "PIPELINE_EVENT",
        event
    }).catch(() => undefined);
}

function createEmptyPipeline() {
    return {
        running: false,
        starting: false,
        stopping: false,
        debugMode: false,
        providerConfig: null,
        tabId: null,
        mediaStream: null,
        audioContext: null,
        sourceNode: null,
        workletNode: null,
        silentGainNode: null,
        deepgramClient: null,
        deepgramConfig: null,
        deepgramProfileId: null,
        isGeminiTranscribe: false,
        translationProfileId: null,
        frameSamples: 1600,
        gemmaClient: null,
        translationScheduler: null,
        bytesSentThisSecond: 0,
        totalBytesSent: 0,
        bytesTimer: null,
        lastAudioLevel: {
            rms: 0,
            peak: 0
        },
        publicState: {
            lifecycle: "Idle",
            deepgram: "Disconnected",
            translator: "Not checked",
            error: "",
            capturingTabId: null,
            startedAt: null
        }
    };
}

function safeDisconnect(node) {
    try {
        node?.disconnect();
    } catch {
        // The node may already be disconnected.
    }
}

function getWebSocketState(socket) {
    const states = ["CONNECTING", "OPEN", "CLOSING", "CLOSED"];
    return socket ? states[socket.readyState] || "UNKNOWN" : "NONE";
}

function round(value, digits) {
    const factor = 10 ** digits;
    return Math.round((Number(value) || 0) * factor) / factor;
}

function toMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
