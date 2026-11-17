export class GeminiTextClient {
    constructor(config, callbacks = {}) {
        this.config = config;
        this.callbacks = callbacks;
    }

    validateConfig() {
        if (!isConfigured(this.config.apiKey)) {
            throw new Error("Gemini API key is missing. Add it in API Settings.");
        }
        if (!isConfigured(this.config.model)) {
            throw new Error("Gemini translation model is not configured.");
        }
        try {
            new URL(this.getEndpoint());
        } catch {
            throw new Error("Gemini API base URL is invalid.");
        }
    }

    async translate(text, options = {}) {
        const normalizedText = normalizeText(text);
        if (!normalizedText) {
            throw new Error("Gemini translation text is empty.");
        }
        this.validateConfig();

        const controller = new AbortController();
        const externalSignal = options.signal;
        let timedOut = false;
        const abortFromExternal = () => controller.abort(externalSignal?.reason);
        if (externalSignal) {
            if (externalSignal.aborted) {
                abortFromExternal();
            } else {
                externalSignal.addEventListener("abort", abortFromExternal, {
                    once: true
                });
            }
        }

        const timeoutMs = this.config.timeoutMs || 15000;
        const timeoutId = setTimeout(() => {
            timedOut = true;
            controller.abort();
        }, timeoutMs);
        const startedAt = performance.now();
        this.callbacks.onRequest?.(normalizedText);

        try {
            const response = await fetch(this.getEndpoint(), {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "x-goog-api-key": this.config.apiKey
                },
                body: JSON.stringify({
                    systemInstruction: {
                        parts: [{ text: this.config.systemPrompt }]
                    },
                    contents: [{
                        role: "user",
                        parts: [{ text: normalizedText }]
                    }],
                    generationConfig: {
                        temperature: 0,
                        maxOutputTokens: this.config.maxTokens || 256,
                        thinkingConfig: {
                            thinkingBudget: 0
                        }
                    }
                }),
                signal: controller.signal
            });

            if (!response.ok) {
                throw new Error(`Gemini API returned HTTP ${response.status}.`);
            }
            const payload = await response.json().catch(() => null);
            const translation = payload?.candidates?.[0]?.content?.parts
                ?.filter((part) => !part.thought && typeof part.text === "string")
                .map((part) => part.text)
                .join("")
                .trim();
            if (!translation) {
                const reason = payload?.candidates?.[0]?.finishReason;
                throw new Error(
                    `Gemini API returned an empty translation${reason ? ` (${reason})` : ""}.`
                );
            }

            const elapsedMs = Math.round(performance.now() - startedAt);
            this.callbacks.onResponse?.(translation, elapsedMs);
            return { text: translation, elapsedMs };
        } catch (error) {
            if (timedOut) {
                throw new Error(`Gemini API timed out after ${timeoutMs} ms.`);
            }
            if (externalSignal?.aborted || error?.name === "AbortError") {
                throw createAbortError();
            }
            if (error instanceof TypeError) {
                throw new Error(
                    "Gemini API network request failed. Check the API key, network, and host permission."
                );
            }
            throw error;
        } finally {
            clearTimeout(timeoutId);
            externalSignal?.removeEventListener("abort", abortFromExternal);
        }
    }

    getEndpoint() {
        const baseUrl = String(this.config.baseUrl || "")
            .trim()
            .replace(/\/+$/, "");
        return `${baseUrl}/models/${encodeURIComponent(this.config.model)}:generateContent`;
    }
}

function isConfigured(value) {
    return Boolean(value) && !String(value).includes("REPLACE_WITH_");
}

function normalizeText(text) {
    return String(text || "").replace(/\s+/g, " ").trim();
}

function createAbortError() {
    const error = new Error("Translation request was aborted.");
    error.name = "AbortError";
    return error;
}
