(function initializeOverlayClass(globalObject) {
    if (globalObject.LiveSubtitleOverlay) {
        return;
    }

    const HOST_ID = "realtime-subtitle-extension-host";
    const MIN_COMPLETED_DISPLAY_MS = 1000;
    const DEFAULT_SETTINGS = {
        fontSize: 30,
        width: 760,
        backgroundOpacity: 78,
        backgroundColor: "#000000",
        englishColor: "#ffffff",
        chineseColor: "#fff3a6",
        showEnglish: true,
        showChinese: true,
        debugMode: false,
        position: null
    };

    class LiveSubtitleOverlay {
        constructor(settings = {}) {
            this.settings = { ...DEFAULT_SETTINGS, ...settings };
            this.finalRows = new Map();
            this.finalOrder = [];
            this.pendingSegments = new Map();
            this.liveSegment = { english: "", chinese: "" };
            this.completedAt = 0;
            this.handoffTimer = null;
            this.dragState = null;
            this.host = document.getElementById(HOST_ID);
            if (this.host) {
                this.host.remove();
            }
            this.createDom();
            this.applySettings(this.settings);
        }

        createDom() {
            this.host = document.createElement("div");
            this.host.id = HOST_ID;
            this.host.style.setProperty("all", "initial", "important");
            this.host.style.setProperty("position", "fixed", "important");
            this.host.style.setProperty("top", "0", "important");
            this.host.style.setProperty("left", "0", "important");
            this.host.style.setProperty("width", "0", "important");
            this.host.style.setProperty("height", "0", "important");
            this.host.style.setProperty("overflow", "visible", "important");
            this.host.style.setProperty("pointer-events", "auto", "important");
            this.host.style.setProperty("z-index", "2147483647", "important");

            const shadow = this.host.attachShadow({ mode: "closed" });
            const style = document.createElement("style");
            style.textContent = `
                :host {
                    all: initial;
                }

                .panel {
                    display: none;
                    position: fixed;
                    left: 50%;
                    bottom: 6vh;
                    box-sizing: border-box;
                    width: 760px;
                    min-width: 360px;
                    max-width: calc(100vw - 24px);
                    max-height: 60vh;
                    padding: 8px 18px 14px;
                    overflow-x: hidden;
                    overflow-y: auto;
                    resize: horizontal;
                    transform: translateX(-50%);
                    border: 1px solid rgba(255, 255, 255, 0.2);
                    border-radius: 12px;
                    background: rgba(0, 0, 0, 0.78);
                    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
                    color: #fff;
                    font-family: Arial, "Noto Sans TC", "Microsoft JhengHei", sans-serif;
                    font-size: 30px;
                    line-height: 1.3;
                    text-align: center;
                    text-shadow: 0 2px 3px rgba(0, 0, 0, 0.85);
                    pointer-events: auto;
                    user-select: none;
                }

                .panel.visible {
                    display: block;
                }

                .drag-handle {
                    display: flex;
                    min-height: 14px;
                    align-items: center;
                    justify-content: center;
                    margin: -4px -10px 3px;
                    color: rgba(255, 255, 255, 0.55);
                    cursor: grab;
                    font: 12px/1 Arial, sans-serif;
                    letter-spacing: 4px;
                    touch-action: none;
                }

                .drag-handle:active {
                    cursor: grabbing;
                }

                .status {
                    display: none;
                    margin: 0 0 6px;
                    color: #ffd166;
                    font: 12px/1.3 Arial, sans-serif;
                    text-align: left;
                    text-shadow: none;
                }

                .status.visible {
                    display: block;
                }

                .segment {
                    padding: 5px 0;
                    border-top: 1px solid rgba(255, 255, 255, 0.12);
                }

                .segment:first-child {
                    border-top: 0;
                }

                .english,
                .chinese {
                    margin: 0;
                    overflow-wrap: anywhere;
                    white-space: pre-wrap;
                }

                .english {
                    color: #fff;
                    font-size: 0.78em;
                    font-weight: 500;
                }

                .chinese {
                    margin-top: 3px;
                    color: #fff3a6;
                    font-size: 1em;
                    font-weight: 700;
                }

                .pending {
                    color: rgba(255, 243, 166, 0.62);
                }

                .current:empty,
                .completed:empty {
                    display: none;
                }

                .hidden {
                    display: none !important;
                }
            `;

            this.panel = document.createElement("section");
            this.panel.className = "panel";
            this.panel.setAttribute("role", "status");
            this.panel.setAttribute("aria-live", "polite");

            this.dragHandle = document.createElement("div");
            this.dragHandle.className = "drag-handle";
            this.dragHandle.textContent = "•••";
            this.dragHandle.title = "Drag subtitles";

            this.statusElement = document.createElement("div");
            this.statusElement.className = "status";

            this.completedElement = document.createElement("div");
            this.completedElement.className = "completed";

            this.currentElement = document.createElement("div");
            this.currentElement.className = "segment current";
            this.currentEnglish = document.createElement("p");
            this.currentEnglish.className = "english";
            this.currentChinese = document.createElement("p");
            this.currentChinese.className = "chinese";
            this.currentElement.append(this.currentEnglish, this.currentChinese);

            this.panel.append(
                this.dragHandle,
                this.statusElement,
                this.completedElement,
                this.currentElement
            );
            shadow.append(style, this.panel);
            document.documentElement.appendChild(this.host);

            this.dragHandle.addEventListener("pointerdown", (event) => {
                this.startDrag(event);
            });
            window.addEventListener("pointermove", (event) => {
                this.moveDrag(event);
            });
            window.addEventListener("pointerup", (event) => {
                this.endDrag(event);
            });
            document.addEventListener("fullscreenchange", () => {
                this.handleFullscreenChange();
            });
            this.panel.addEventListener("pointerup", () => {
                this.persistGeometry();
            });
        }

        setInterimEnglish(text) {
            this.liveSegment.english = text || "";
            this.advanceSubtitles();
        }

        setInterimTranslation(text) {
            this.liveSegment.chinese = text || "";
            this.advanceSubtitles();
        }

        addFinalSegment(segment) {
            if (!segment?.id || this.finalRows.has(segment.id)
                || this.pendingSegments.has(segment.id)) {
                return;
            }

            this.pendingSegments.set(segment.id, {
                id: segment.id,
                english: segment.english || "",
                chinese: segment.chinese || this.liveSegment.chinese,
                status: segment.status === "complete" ? "complete" : "translating"
            });
            this.liveSegment = { english: "", chinese: "" };
            this.advanceSubtitles();
        }

        updateFinalTranslation(segment) {
            const pending = this.pendingSegments.get(segment?.id);
            if (!pending || pending.status !== "translating"
                || !["complete", "error"].includes(segment.status)) {
                return;
            }
            pending.chinese = segment.chinese || "";
            pending.status = segment.status;
            this.advanceSubtitles();
        }

        advanceSubtitles() {
            clearTimeout(this.handoffTimer);
            this.handoffTimer = null;
            let pending = this.pendingSegments.values().next().value;
            while (pending?.status === "error"
                && (this.pendingSegments.size > 1
                    || this.liveSegment.english || this.liveSegment.chinese)) {
                this.pendingSegments.delete(pending.id);
                pending = this.pendingSegments.values().next().value;
            }

            if (pending?.status === "complete") {
                const waitMs = this.finalOrder.length
                    ? MIN_COMPLETED_DISPLAY_MS - (Date.now() - this.completedAt)
                    : 0;
                if (waitMs > 0) {
                    this.handoffTimer = setTimeout(() => this.advanceSubtitles(), waitMs);
                } else {
                    this.pendingSegments.delete(pending.id);
                    this.showCompletedSegment(pending);
                    this.completedAt = Date.now();
                    // Render the next waiting sentence in the same handoff. If it
                    // is already complete, allow reading time before moving it up.
                    this.advanceSubtitles();
                    return;
                }
            }

            const current = pending || this.liveSegment;
            this.currentEnglish.textContent = current.english;
            this.currentChinese.textContent = current.chinese || (pending ? "翻譯中…" : "");
            this.currentElement.style.display = this.currentEnglish.textContent
                || this.currentChinese.textContent ? "" : "none";
            this.updatePanelVisibility();
            this.reportRendered("current");
        }

        showCompletedSegment(segment) {
            // Completed rows are created once, with their final translation.
            const row = document.createElement("div");
            row.className = "segment";
            row.dataset.segmentId = segment.id;
            const english = document.createElement("p");
            english.className = "english";
            english.textContent = segment.english;
            const chinese = document.createElement("p");
            chinese.className = "chinese";
            chinese.textContent = segment.chinese || "";
            row.append(english, chinese);
            this.completedElement.appendChild(row);

            this.finalRows.set(segment.id, { row, english, chinese });
            this.finalOrder.push(segment.id);
            this.trimFinalRows();
            this.applyLanguageVisibility();
            this.reportRendered("final-chinese", segment.id);
        }

        clear() {
            this.finalRows.clear();
            this.finalOrder = [];
            this.pendingSegments.clear();
            this.liveSegment = { english: "", chinese: "" };
            clearTimeout(this.handoffTimer);
            this.handoffTimer = null;
            this.completedAt = 0;
            this.completedElement.replaceChildren();
            this.currentEnglish.textContent = "";
            this.currentChinese.textContent = "";
            this.currentElement.style.display = "none";
            this.updatePanelVisibility();
        }

        showStatus(status, error = "") {
            const message = error || status || "";
            this.statusElement.textContent = message;
            this.statusElement.dataset.hasError = String(Boolean(error));
            this.statusElement.classList.toggle(
                "visible",
                Boolean(message) && (this.settings.debugMode || Boolean(error))
            );
            this.updatePanelVisibility();
        }

        applySettings(settings) {
            this.settings = { ...this.settings, ...(settings || {}) };
            const fontSize = clamp(Number(this.settings.fontSize) || 30, 18, 64);
            const width = clamp(Number(this.settings.width) || 760, 360, 1400);
            const backgroundOpacity = clamp(
                Number(this.settings.backgroundOpacity) || 0,
                0,
                100
            );
            this.panel.style.fontSize = `${fontSize}px`;
            this.panel.style.width = `${width}px`;
            this.panel.style.backgroundColor = colorWithOpacity(
                this.settings.backgroundColor,
                backgroundOpacity / 100
            );
            this.applyLanguageVisibility();

            const position = this.settings.position;
            if (position
                && Number.isFinite(position.left)
                && Number.isFinite(position.top)) {
                this.panel.style.left = `${position.left}px`;
                this.panel.style.top = `${position.top}px`;
                this.panel.style.bottom = "auto";
                this.panel.style.transform = "none";
                this.clampToViewport();
            } else {
                this.panel.style.left = "50%";
                this.panel.style.top = "auto";
                this.panel.style.bottom = "6vh";
                this.panel.style.transform = "translateX(-50%)";
            }
            this.showStatus(
                this.statusElement.textContent,
                this.statusElement.dataset.hasError === "true"
                    ? this.statusElement.textContent
                    : ""
            );
        }

        applyLanguageVisibility() {
            const englishElements = this.panel.querySelectorAll(".english");
            const chineseElements = this.panel.querySelectorAll(".chinese");
            for (const element of englishElements) {
                element.classList.toggle("hidden", !this.settings.showEnglish);
                element.style.color = normalizeColor(this.settings.englishColor, "#ffffff");
            }
            for (const element of chineseElements) {
                element.classList.toggle("hidden", !this.settings.showChinese);
                element.style.color = normalizeColor(this.settings.chineseColor, "#fff3a6");
            }
        }

        trimFinalRows() {
            const limit = 1;
            while (this.finalOrder.length > limit) {
                const oldestId = this.finalOrder.shift();
                this.finalRows.get(oldestId)?.row.remove();
                this.finalRows.delete(oldestId);
            }
        }

        updatePanelVisibility() {
            const hasSubtitles = this.finalOrder.length > 0
                || Boolean(this.currentEnglish.textContent)
                || Boolean(this.currentChinese.textContent);
            const hasStatus = this.statusElement.classList.contains("visible");
            const shouldShow = hasSubtitles || hasStatus;
            this.panel.classList.toggle("visible", shouldShow);
            this.syncTopLayer(shouldShow);
            if (shouldShow && this.settings.position) {
                this.clampToViewport();
            }
            this.syncHostHitArea();
        }

        handleFullscreenChange() {
            const shouldShow = this.panel.classList.contains("visible");
            this.syncTopLayer(shouldShow);
            if (shouldShow && this.settings.position) {
                this.clampToViewport();
            }
            this.syncHostHitArea();
        }

        syncTopLayer(shouldShow) {
            // Container fullscreen (including YouTube) already renders descendants.
            // Only a replaced video element needs a separate top-layer overlay.
            const needsPopover = document.fullscreenElement?.tagName === "VIDEO";
            if (!needsPopover) {
                if (this.host.hasAttribute("popover")) {
                    try {
                        if (this.supportsPopover() && this.host.matches(":popover-open")) {
                            this.host.hidePopover();
                        }
                    } catch {
                        // The browser may already have closed it during fullscreen exit.
                    }
                    this.host.removeAttribute("popover");
                }
                this.reparentForFullscreen();
                this.syncHostHitArea();
                return;
            }
            if (this.supportsPopover()) {
                try {
                    this.host.setAttribute("popover", "manual");
                    const isOpen = this.host.matches(":popover-open");
                    if (shouldShow && !isOpen) {
                        this.reparentForFullscreen();
                        this.host.showPopover();
                    } else if (!shouldShow && isOpen) {
                        this.host.hidePopover();
                    }
                    this.syncHostHitArea();
                    return;
                } catch {
                    // Fall back to normal DOM rendering.
                }
            }
            if (shouldShow) {
                this.reparentForFullscreen();
            }
        }

        reparentForFullscreen() {
            const fullscreenElement = document.fullscreenElement;
            const target = fullscreenElement instanceof Element
                ? fullscreenElement
                : document.documentElement;
            if (this.host.parentElement !== target) {
                target.appendChild(this.host);
            }
        }

        supportsPopover() {
            return typeof this.host.showPopover === "function"
                && typeof this.host.hidePopover === "function";
        }

        syncHostHitArea() {
            if (!this.panel.classList.contains("visible")) {
                this.host.style.setProperty("width", "0", "important");
                this.host.style.setProperty("height", "0", "important");
                return;
            }
            const rect = this.panel.getBoundingClientRect();
            this.host.style.setProperty("top", `${rect.top}px`, "important");
            this.host.style.setProperty("left", `${rect.left}px`, "important");
            this.host.style.setProperty("width", `${rect.width}px`, "important");
            this.host.style.setProperty("height", `${rect.height}px`, "important");
        }

        startDrag(event) {
            if (event.button !== 0) {
                return;
            }
            const rect = this.panel.getBoundingClientRect();
            this.panel.style.left = `${rect.left}px`;
            this.panel.style.top = `${rect.top}px`;
            this.panel.style.bottom = "auto";
            this.panel.style.transform = "none";
            this.dragState = {
                pointerId: event.pointerId,
                offsetX: event.clientX - rect.left,
                offsetY: event.clientY - rect.top
            };
            this.dragHandle.setPointerCapture(event.pointerId);
            event.preventDefault();
        }

        moveDrag(event) {
            if (!this.dragState || event.pointerId !== this.dragState.pointerId) {
                return;
            }
            const maxLeft = Math.max(0, window.innerWidth - this.panel.offsetWidth);
            const maxTop = Math.max(0, window.innerHeight - this.panel.offsetHeight);
            const left = clamp(event.clientX - this.dragState.offsetX, 0, maxLeft);
            const top = clamp(event.clientY - this.dragState.offsetY, 0, maxTop);
            this.panel.style.left = `${left}px`;
            this.panel.style.top = `${top}px`;
            this.syncHostHitArea();
        }

        endDrag(event) {
            if (!this.dragState || event.pointerId !== this.dragState.pointerId) {
                return;
            }
            this.dragState = null;
            this.syncHostHitArea();
            this.persistGeometry();
        }

        clampToViewport() {
            const rect = this.panel.getBoundingClientRect();
            const left = clamp(rect.left, 0, Math.max(0, window.innerWidth - rect.width));
            const top = clamp(rect.top, 0, Math.max(0, window.innerHeight - rect.height));
            this.panel.style.left = `${left}px`;
            this.panel.style.top = `${top}px`;
        }

        persistGeometry() {
            const rect = this.panel.getBoundingClientRect();
            const settings = {
                width: Math.round(rect.width),
                position: {
                    left: Math.round(rect.left),
                    top: Math.round(rect.top)
                }
            };
            this.sendRuntimeMessage({
                action: "UPDATE_SETTINGS",
                settings
            });
        }

        reportRendered(kind, segmentId = null) {
            if (!this.settings.debugMode) {
                return;
            }
            this.sendRuntimeMessage({
                action: "OVERLAY_RENDERED",
                data: {
                    kind,
                    segmentId,
                    renderedAt: Date.now()
                }
            });
        }

        sendRuntimeMessage(message) {
            try {
                const response = globalThis.chrome?.runtime?.sendMessage?.(message);
                response?.catch?.(() => undefined);
            } catch (error) {
                if (!String(error).includes("Extension context invalidated")) {
                    console.debug("Subtitle message was not sent:", error);
                }
            }
        }
    }

    function clamp(value, minimum, maximum) {
        return Math.min(maximum, Math.max(minimum, value));
    }

    function normalizeColor(value, fallback) {
        return /^#[0-9a-f]{6}$/iu.test(String(value || "")) ? value : fallback;
    }

    function colorWithOpacity(hex, opacity) {
        const color = normalizeColor(hex, "#000000").slice(1);
        const red = Number.parseInt(color.slice(0, 2), 16);
        const green = Number.parseInt(color.slice(2, 4), 16);
        const blue = Number.parseInt(color.slice(4, 6), 16);
        return `rgba(${red}, ${green}, ${blue}, ${opacity})`;
    }

    globalObject.LiveSubtitleOverlay = LiveSubtitleOverlay;
})(globalThis);
