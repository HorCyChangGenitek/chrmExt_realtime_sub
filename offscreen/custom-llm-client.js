export class CustomLlmClient {
    constructor(config, callbacks = {}) {
        this.config = config;
        this.callbacks = callbacks;
    }

    validateConfig() {
        const required = [
            ["base URL", this.config.baseUrl],
            ["model", this.config.model]
        ];
        for (const [label, value] of required) {
            if (!String(value || "").trim()) {
                throw new Error(`Custom LLM ${label} is not configured in API Settings.`);
            }
        }
        try {
            new URL(this.getEndpoint());
        } catch {
            throw new Error("Custom LLM Base URL in API Settings is invalid.");
        }
    }

    async testConnection() {
        this.validateConfig();
        return true;
    }

    async translate(text, options = {}) {
        const normalizedText = normalizeText(text);
        if (!normalizedText) {
            throw new Error("Custom LLM translation text is empty.");
        }
        this.validateConfig();

        const controller = new AbortController();
        const externalSignal = options.signal;
        let timedOut = false;
        const abortFromExternal = () => {
            controller.abort(externalSignal?.reason);
        };
        if (externalSignal) {
            if (externalSignal.aborted) {
                abortFromExternal();
            } else {
                externalSignal.addEventListener("abort", abortFromExternal, {
                    once: true
                });
            }
        }

        const timeoutId = setTimeout(() => {
            timedOut = true;
            controller.abort();
        }, this.config.timeoutMs || 15000);
        const startedAt = performance.now();
        this.callbacks.onRequest?.(normalizedText);

        try {
            const headers = {
                "Content-Type": "application/json"
            };
            if (String(this.config.apiKey || "").trim()) {
                headers.Authorization = `Bearer ${this.config.apiKey.trim()}`;
            }
            const response = await fetch(this.getEndpoint(), {
                method: "POST",
                headers,
                body: JSON.stringify({
                    model: this.config.model,
                    temperature: 0,
                    max_tokens: this.config.maxTokens || 256,
                    stream: false,
                    messages: [
                        {
                            role: "system",
                            content: this.config.systemPrompt
                        },
                        {
                            role: "user",
                            content: normalizedText
                        }
                    ]
                }),
                signal: controller.signal
            });

            if (!response.ok) {
                throw new Error(`Custom LLM returned HTTP ${response.status}.`);
            }

            let payload;
            try {
                payload = await response.json();
            } catch {
                throw new Error("Custom LLM returned invalid JSON.");
            }

            const translation = payload?.choices?.[0]?.message?.content?.trim();
            if (!translation) {
                throw new Error("Custom LLM returned an empty translation.");
            }

            const elapsedMs = Math.round(performance.now() - startedAt);
            this.callbacks.onResponse?.(translation, elapsedMs);
            return {
                text: translation,
                elapsedMs
            };
        } catch (error) {
            if (timedOut) {
                throw new Error(`Custom LLM timed out after ${this.config.timeoutMs || 15000} ms.`);
            }
            if (externalSignal?.aborted || error?.name === "AbortError") {
                throw createAbortError();
            }
            if (error instanceof TypeError) {
                throw new Error(
                    "Custom LLM network request failed. Check the URL, port, firewall, and host permission."
                );
            }
            throw error;
        } finally {
            clearTimeout(timeoutId);
            externalSignal?.removeEventListener("abort", abortFromExternal);
        }
    }

    getEndpoint() {
        const baseUrl = String(this.config.baseUrl || "").trim().replace(/\/+$/, "");
        if (baseUrl.endsWith("/chat/completions")) {
            return baseUrl;
        }
        return `${baseUrl}/chat/completions`;
    }
}

function normalizeText(text) {
    return String(text || "").replace(/\s+/g, " ").trim();
}

function createAbortError() {
    const error = new Error("Translation request was aborted.");
    error.name = "AbortError";
    return error;
}
