export const SYSTEM_PROMPT = `You are a real-time multilingual subtitle translator.

Detect the source language of the provided speech transcript and translate it into natural Traditional Chinese used in Taiwan.

Requirements:
- Output Traditional Chinese only.
- Do not output explanations, notes, labels, or quotation marks.
- Do not use Simplified Chinese.
- Prefer terminology commonly used in Taiwan.
- Preserve names, product names, acronyms, model names, company names, and technical terms when appropriate.
- Keep the translation concise enough for live subtitles.
- Translate incomplete speech fragments naturally, but do not invent missing information or wait for a complete sentence.
- If the input is already Chinese, return natural Traditional Chinese used in Taiwan.`;

// Shared non-secret defaults only. User API keys and custom endpoints belong in the extension UI.
export const CONFIG = {
    deepgram: {
        defaultProfile: "nova-3",
        maxReconnectAttempts: 3,
        profiles: {
            "nova-3": {
                label: "Nova-3 (v1)",
                provider: "deepgram",
                protocol: "nova-v1",
                endpoint: "wss://api.deepgram.com/v1/listen",
                model: "nova-3",
                language: "en-US",
                audioFrameMs: 100
            },
            "flux-general-en": {
                label: "Flux General English (v2)",
                provider: "deepgram",
                protocol: "flux-v2",
                endpoint: "wss://api.deepgram.com/v2/listen",
                model: "flux-general-en",
                audioFrameMs: 80,
                eotThreshold: 0.7,
                eotTimeoutMs: 800,
                maxSegmentWords: 16,
                minSegmentWords: 6,
                segmentTailWords: 4
            },
            "flux-general-multi-auto": {
                label: "Flux Multilingual Auto (v2)",
                provider: "deepgram",
                protocol: "flux-v2",
                endpoint: "wss://api.deepgram.com/v2/listen",
                model: "flux-general-multi",
                audioFrameMs: 80,
                eotThreshold: 0.7,
                eotTimeoutMs: 800,
                maxSegmentWords: 16,
                minSegmentWords: 6,
                segmentTailWords: 4
            },
            "gemini-3.5-transcribe-live": {
                label: "Gemini 3.5 Transcribe Live",
                provider: "gemini-transcribe",
                model: "gemini-3.5-transcribe-live",
                audioFrameMs: 100,
                transcriptionMode: "VERBATIM",
                sessionRotationMs: 570000,
                maxSegmentWords: 16,
                segmentTailWords: 4,
                maxSegmentChars: 100,
                segmentTailChars: 24
            }
        }
    },
    gemini: {
        baseUrl: "https://generativelanguage.googleapis.com/v1beta",
        liveEndpoint: "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent",
        timeoutMs: 15000
    },
    customLlm: {
        timeoutMs: 15000,
        maxTokens: 256,
        systemPrompt: SYSTEM_PROMPT
    },
    translation: {
        defaultProfile: "custom-llm",
        profiles: {
            "custom-llm": {
                label: "Custom LLM",
                provider: "custom-llm"
            },
            "gemini-3.1-flash-lite": {
                label: "Gemini 3.1 Flash-Lite",
                provider: "gemini",
                model: "gemini-3.1-flash-lite"
            }
        },
        debounceMs: 120,
        interimCadenceMs: 600
    },
    subtitles: {
        completedSegmentLimit: 1
    }
};
