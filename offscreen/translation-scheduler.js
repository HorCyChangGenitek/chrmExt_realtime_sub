const MAX_PENDING_FINAL_REQUESTS = 20;

export class TranslationScheduler {
    constructor(options) {
        this.gemmaClient = options.gemmaClient;
        this.debounceMs = options.debounceMs || 120;
        this.interimCadenceMs = options.interimCadenceMs || 600;
        this.callbacks = options.callbacks || {};
        this.state = this.createInitialState();
        this.finalRequests = new Map();
        this.finalQueue = [];
        this.processingFinalQueue = false;
        this.stopped = false;
    }

    handleInterim(text, metadata = {}) {
        const normalized = normalizeText(text);
        if (!normalized || normalized === this.state.latestInterimText) {
            return;
        }

        this.state.latestInterimText = normalized;
        this.state.latestInterimMetadata = metadata;
        this.state.interimSequence += 1;

        this.callbacks.onInterimEnglish?.(normalized, metadata);
        if (!isMeaningfulFragment(normalized)
            || normalized === this.state.lastTranslatedInterimText) {
            return;
        }

        this.scheduleInterimTranslation();
    }

    handleFinal(segment, metadata = {}) {
        const normalized = normalizeText(segment.english);
        if (!normalized || normalized === this.state.lastTranslatedFinalText) {
            return;
        }
        const cachedTranslation = this.state.lastInterimTranslation?.sourceText === normalized
            ? this.state.lastInterimTranslation
            : null;

        clearTimeout(this.state.debounceTimer);
        this.state.debounceTimer = null;
        if (this.state.activeInterimAbortController) {
            this.state.activeInterimAbortController.abort();
            this.state.activeInterimAbortController = null;
            this.callbacks.onDebug?.("Aborted interim translation for final result", {});
        }

        this.state.interimSequence += 1;
        this.state.interimGeneration += 1;
        this.state.latestInterimText = "";
        this.state.latestInterimMetadata = {};
        this.state.lastTranslatedInterimText = "";
        this.state.lastInterimTranslation = null;
        this.state.lastInterimRequestAt = 0;
        this.state.latestFinalText = normalized;
        this.state.lastTranslatedFinalText = normalized;
        this.state.finalSequence += 1;
        const sequence = this.state.finalSequence;
        const finalSegment = {
            ...segment,
            english: normalized,
            chinese: cachedTranslation?.text || "",
            status: cachedTranslation ? "complete" : "translating"
        };

        this.callbacks.onFinalEnglish?.(finalSegment, metadata);
        if (cachedTranslation) {
            this.callbacks.onFinalTranslation?.(finalSegment, {
                ...metadata,
                sourceText: normalized,
                elapsedMs: cachedTranslation.elapsedMs,
                sequence,
                reusedInterim: true
            });
            this.callbacks.onTranslating?.(
                this.finalRequests.size > 0
                    || this.finalQueue.length > 0
                    || this.processingFinalQueue
            );
            return;
        }
        if (this.finalQueue.length >= MAX_PENDING_FINAL_REQUESTS) {
            const dropped = this.finalQueue.shift();
            this.callbacks.onFinalTranslation?.({
                id: dropped.segment.id,
                english: dropped.segment.english,
                chinese: "翻譯佇列已滿",
                status: "error"
            });
            this.callbacks.onDebug?.("Dropped queued final translation", {
                segmentId: dropped.segment.id
            });
        }
        this.finalQueue.push({
            segment: finalSegment,
            sequence,
            metadata
        });
        void this.processFinalQueue();
    }

    scheduleInterimTranslation() {
        if (this.stopped
            || this.state.debounceTimer
            || this.state.activeInterimAbortController) {
            return;
        }

        const text = this.state.latestInterimText;
        if (!isMeaningfulFragment(text)
            || text === this.state.lastTranslatedInterimText) {
            return;
        }

        const elapsed = Date.now() - this.state.lastInterimRequestAt;
        const delayMs = this.state.lastInterimRequestAt === 0
            ? this.debounceMs
            : Math.max(0, this.interimCadenceMs - elapsed);
        this.state.debounceTimer = setTimeout(() => {
            this.state.debounceTimer = null;
            const snapshot = this.state.latestInterimText;
            if (!isMeaningfulFragment(snapshot)
                || snapshot === this.state.lastTranslatedInterimText) {
                return;
            }
            this.state.lastInterimRequestAt = Date.now();
            void this.translateInterim(
                snapshot,
                this.state.interimSequence,
                this.state.interimGeneration,
                this.state.latestInterimMetadata
            );
        }, delayMs);
    }

    async translateInterim(text, sequence, generation, metadata) {
        const controller = new AbortController();
        this.state.activeInterimAbortController = controller;
        this.callbacks.onTranslating?.(true);
        try {
            const result = await this.gemmaClient.translate(text, {
                signal: controller.signal
            });
            if (generation !== this.state.interimGeneration
                || !this.state.latestInterimText) {
                this.callbacks.onDebug?.("Discarded expired interim translation", {
                    sequence
                });
                return;
            }
            this.state.lastTranslatedInterimText = text;
            this.state.lastInterimTranslation = {
                sourceText: text,
                text: result.text,
                elapsedMs: result.elapsedMs
            };
            this.callbacks.onInterimTranslation?.(result.text, {
                ...metadata,
                sourceText: text,
                elapsedMs: result.elapsedMs,
                sequence
            });
        } catch (error) {
            if (error?.name === "AbortError") {
                this.callbacks.onDebug?.("Interim translation request aborted", {
                    sequence
                });
                return;
            }
            this.callbacks.onTranslationError?.(error, {
                kind: "interim",
                sequence
            });
        } finally {
            if (this.state.activeInterimAbortController === controller) {
                this.state.activeInterimAbortController = null;
                this.callbacks.onTranslating?.(this.finalRequests.size > 0);
            }
            this.scheduleInterimTranslation();
        }
    }

    async translateFinal(segment, sequence, metadata) {
        const controller = new AbortController();
        this.finalRequests.set(segment.id, {
            controller,
            sequence,
            segment
        });
        this.callbacks.onTranslating?.(true);

        try {
            const result = await this.gemmaClient.translate(segment.english, {
                signal: controller.signal
            });
            const activeRequest = this.finalRequests.get(segment.id);
            if (!activeRequest || activeRequest.sequence !== sequence) {
                this.callbacks.onDebug?.("Discarded expired final translation", {
                    segmentId: segment.id,
                    sequence
                });
                return;
            }
            this.callbacks.onFinalTranslation?.(
                {
                    id: segment.id,
                    english: segment.english,
                    chinese: result.text,
                    status: "complete"
                },
                {
                    ...metadata,
                    sourceText: segment.english,
                    elapsedMs: result.elapsedMs,
                    sequence
                }
            );
        } catch (error) {
            if (error?.name !== "AbortError") {
                this.callbacks.onTranslationError?.(error, {
                    kind: "final",
                    segmentId: segment.id,
                    sequence
                });
                this.callbacks.onFinalTranslation?.({
                    id: segment.id,
                    english: segment.english,
                    chinese: "翻譯失敗",
                    status: "error"
                });
            }
        } finally {
            const activeRequest = this.finalRequests.get(segment.id);
            if (activeRequest?.sequence === sequence) {
                this.finalRequests.delete(segment.id);
            }
            if (this.stopped) {
                this.callbacks.onTranslating?.(false);
            } else {
                this.callbacks.onTranslating?.(
                    Boolean(this.state.activeInterimAbortController)
                        || this.finalRequests.size > 0
                        || this.finalQueue.length > 0
                        || this.processingFinalQueue
                );
            }
        }
    }

    async processFinalQueue() {
        if (this.processingFinalQueue || this.stopped) {
            return;
        }
        this.processingFinalQueue = true;
        try {
            while (this.finalQueue.length > 0 && !this.stopped) {
                const job = this.finalQueue.shift();
                await this.translateFinal(
                    job.segment,
                    job.sequence,
                    job.metadata
                );
            }
        } finally {
            this.processingFinalQueue = false;
            this.callbacks.onTranslating?.(
                Boolean(this.state.activeInterimAbortController)
                    || this.finalRequests.size > 0
                    || this.finalQueue.length > 0
            );
        }
    }

    stop() {
        this.stopped = true;
        clearTimeout(this.state.debounceTimer);
        if (this.state.activeInterimAbortController) {
            this.state.activeInterimAbortController.abort();
        }
        for (const request of this.finalRequests.values()) {
            request.controller.abort();
            this.callbacks.onFinalTranslation?.({
                id: request.segment.id,
                english: request.segment.english,
                chinese: "翻譯已停止",
                status: "error"
            });
        }
        for (const job of this.finalQueue) {
            this.callbacks.onFinalTranslation?.({
                id: job.segment.id,
                english: job.segment.english,
                chinese: "翻譯已停止",
                status: "error"
            });
        }
        this.finalRequests.clear();
        this.finalQueue = [];
        this.state = this.createInitialState();
        this.callbacks.onTranslating?.(false);
    }

    createInitialState() {
        return {
            latestInterimText: "",
            latestInterimMetadata: {},
            latestFinalText: "",
            lastTranslatedInterimText: "",
            lastInterimTranslation: null,
            lastTranslatedFinalText: "",
            activeInterimAbortController: null,
            interimSequence: 0,
            interimGeneration: 0,
            finalSequence: 0,
            debounceTimer: null,
            lastInterimRequestAt: 0
        };
    }
}

function normalizeText(text) {
    return String(text || "").replace(/\s+/g, " ").trim();
}

function isMeaningfulFragment(text) {
    if (text.length < 3) {
        return false;
    }
    return !/^(a|an|the|i|it|is|to|of)$/i.test(text);
}
