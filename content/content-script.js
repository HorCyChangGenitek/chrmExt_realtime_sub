(function initializeContentScript() {
    if (globalThis.__REALTIME_SUBTITLE_CONTENT_INITIALIZED__) {
        return;
    }
    globalThis.__REALTIME_SUBTITLE_CONTENT_INITIALIZED__ = true;

    let overlay = null;
    let settings = {};

    document.addEventListener("fullscreenchange", () => {
        try {
            void chrome.runtime.sendMessage({
                action: "CAPTURE_FULLSCREEN_CHANGED",
                fullscreen: Boolean(document.fullscreenElement)
            }).catch(() => undefined);
        } catch {
            // An old page can outlive a reloaded extension.
        }
    });

    void chrome.storage.local.get("subtitleSettings").then((stored) => {
        settings = stored.subtitleSettings || {};
    });

    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (!message || typeof message.action !== "string") {
            return false;
        }

        if (message.action === "PING") {
            ensureOverlay();
            sendResponse({ ok: true });
            return false;
        }

        switch (message.action) {
            case "GET_FULLSCREEN_STATE":
                sendResponse({ ok: true, fullscreen: Boolean(document.fullscreenElement) });
                return false;
            case "INTERIM_ENGLISH":
                ensureOverlay();
                overlay.setInterimEnglish(message.text);
                break;
            case "INTERIM_TRANSLATION":
                ensureOverlay();
                overlay.setInterimTranslation(message.text);
                break;
            case "FINAL_SEGMENT":
                ensureOverlay();
                overlay.addFinalSegment(message.segment);
                break;
            case "FINAL_TRANSLATION":
                ensureOverlay();
                overlay.updateFinalTranslation(message.segment);
                break;
            case "CLEAR_SUBTITLES":
                ensureOverlay();
                overlay.clear();
                break;
            case "SETTINGS_UPDATE":
                settings = { ...settings, ...(message.settings || {}) };
                overlay?.applySettings(settings);
                break;
            case "PIPELINE_STATUS":
                overlay?.showStatus(message.status, message.error);
                break;
            default:
                return false;
        }
        sendResponse({ ok: true });
        return false;
    });

    chrome.storage.onChanged.addListener((changes, areaName) => {
        if (areaName !== "local" || !changes.subtitleSettings?.newValue) {
            return;
        }
        settings = {
            ...settings,
            ...changes.subtitleSettings.newValue
        };
        overlay?.applySettings(settings);
    });

    function ensureOverlay() {
        if (!overlay) {
            overlay = new globalThis.LiveSubtitleOverlay(settings);
        }
    }
})();
