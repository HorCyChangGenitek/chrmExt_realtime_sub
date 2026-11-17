import { CONFIG } from "../config.js";
import { createCaptureFullscreen } from "./capture-fullscreen.js";

const OFFSCREEN_DOCUMENT_PATH = "offscreen/offscreen.html";

const DEFAULT_STATE = {
    lifecycle: "Idle",
    deepgram: "Disconnected",
    translator: "Not checked",
    error: "",
    capturingTabId: null,
    subtitleTabId: null,
    startedAt: null,
    debug: {}
};

let state = { ...DEFAULT_STATE };
let starting = false;
const stateReady = restoreState();
const captureFullscreen = createCaptureFullscreen(chrome, () => state.capturingTabId);
const storageAccessReady = restrictStorageToExtensionContexts();

chrome.runtime.onInstalled.addListener(async () => {
    await storageAccessReady;
    const stored = await chrome.storage.local.get("subtitleSettings");
    if (!stored.subtitleSettings) {
        await chrome.storage.local.set({
            subtitleSettings: {
                fontSize: 30,
                width: 760,
                backgroundOpacity: 78,
                backgroundColor: "#000000",
                englishColor: "#ffffff",
                chineseColor: "#fff3a6",
                deepgramProfile: CONFIG.deepgram.defaultProfile,
                translationProfile: CONFIG.translation.defaultProfile,
                showEnglish: true,
                showChinese: true,
                debugMode: false,
                position: null
            }
        });
    }
    const settings = stored.subtitleSettings || {};
    if (settings.translationProfile === "local-gemma") {
        await chrome.storage.local.set({
            subtitleSettings: {
                ...settings,
                translationProfile: "custom-llm"
            }
        });
    }
    const apiSettings = await chrome.storage.local.get("apiSettings");
    if (!apiSettings.apiSettings) {
        await chrome.storage.local.set({ apiSettings: createDefaultApiSettings() });
    }
    await persistState();
});

chrome.runtime.onStartup.addListener(async () => {
    await restoreState();
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    handleMessage(message, sender)
        .then((response) => sendResponse(response))
        .catch(async (error) => {
            await setError(toMessage(error));
            sendResponse({ ok: false, error: toMessage(error) });
        });
    return true;
});

chrome.tabs.onRemoved.addListener((tabId) => {
    if (tabId === state.capturingTabId) {
        void stopCapture("Captured tab was closed.", true);
    }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (tabId === state.capturingTabId && changeInfo.status === "loading") {
        void stopCapture("Captured tab was reloaded or navigated.", true);
    }
});

async function handleMessage(message, sender) {
    await storageAccessReady;
    await stateReady;
    if (!message || typeof message.action !== "string") {
        return { ok: false, error: "Invalid message." };
    }

    switch (message.action) {
        case "CAPTURE_FULLSCREEN_CHANGED":
            if (sender.id === chrome.runtime.id && sender.frameId === 0) {
                await captureFullscreen.change(sender.tab, message.fullscreen === true);
            }
            return { ok: true };
        case "START_CAPTURE":
            if (!isPopupSender(sender)) {
                return { ok: false, error: "Capture can only be started from the extension popup." };
            }
            return startCapture(
                message.deepgramProfile,
                message.translationProfile
            );
        case "STOP_CAPTURE":
            await stopCapture("Stopped by user.", false);
            return { ok: true, state };
        case "GET_STATUS":
            await syncStateFromOffscreen();
            return { ok: true, state };
        case "CLEAR_SUBTITLES":
            await clearSubtitles();
            return { ok: true };
        case "UPDATE_SETTINGS":
            await updateSettings(message.settings);
            return { ok: true };
        case "OVERLAY_RENDERED":
            state.debug = {
                ...state.debug,
                lastRender: message.data || {}
            };
            await persistState();
            await broadcastToPopup({
                action: "STATUS_UPDATE",
                state
            });
            return { ok: true };
        case "PIPELINE_EVENT":
            if (!isOffscreenSender(sender)) {
                return { ok: false, error: "Untrusted pipeline event." };
            }
            await handlePipelineEvent(message.event);
            return { ok: true };
        default:
            return { ok: false, error: `Unknown action: ${message.action}` };
    }
}

async function startCapture(requestedProfile, requestedTranslationProfile) {
    if (starting) {
        return { ok: false, error: "Capture is already starting." };
    }
    if (isCaptureActive()) {
        return { ok: false, error: "Capture is already active." };
    }

    starting = true;
    try {
        const storedSettings = await chrome.storage.local.get([
            "subtitleSettings",
            "apiSettings"
        ]);
        const selectedProfile = CONFIG.deepgram.profiles[requestedProfile]
            ? requestedProfile
            : storedSettings.subtitleSettings?.deepgramProfile
                || CONFIG.deepgram.defaultProfile;
        const selectedTranslationProfile = CONFIG.translation.profiles[
            requestedTranslationProfile
        ]
            ? requestedTranslationProfile
            : storedSettings.subtitleSettings?.translationProfile === "local-gemma"
                ? "custom-llm"
                : storedSettings.subtitleSettings?.translationProfile
                    || CONFIG.translation.defaultProfile;
        const providerConfig = await buildProviderConfig(
            selectedProfile,
            selectedTranslationProfile,
            storedSettings.apiSettings
        );

        const [tab] = await chrome.tabs.query({
            active: true,
            lastFocusedWindow: true
        });
        if (!tab || !Number.isInteger(tab.id)) {
            throw new Error("No active tab is available.");
        }
        if (!isSupportedTabUrl(tab.url)) {
            throw new Error("This page cannot be captured. Open a normal http or https page.");
        }

        await ensureContentScript(tab.id);
        await ensureOffscreenDocument();
        await updateState({
            lifecycle: "Capturing",
            deepgram: "Connecting",
            translator: "Not checked",
            error: "",
            capturingTabId: tab.id,
            subtitleTabId: tab.id,
            startedAt: Date.now(),
            debug: {}
        });

        const captureSettings = {
            ...(storedSettings.subtitleSettings || {}),
            deepgramProfile: selectedProfile,
            translationProfile: selectedTranslationProfile
        };
        await chrome.storage.local.set({ subtitleSettings: captureSettings });
        const streamId = await getMediaStreamId(tab.id);
        const response = await sendRuntimeMessage({
            action: "OFFSCREEN_START",
            streamId,
            tabId: tab.id,
            settings: captureSettings,
            providerConfig
        });
        if (!response?.ok) {
            throw new Error(response?.error || "The offscreen capture pipeline did not start.");
        }

        const fullscreen = await chrome.tabs.sendMessage(tab.id, {
            action: "GET_FULLSCREEN_STATE"
        }).catch(() => null);
        if (fullscreen?.fullscreen) {
            await captureFullscreen.change(await chrome.tabs.get(tab.id), true);
        }

        return { ok: true, state };
    } catch (error) {
        await sendRuntimeMessage({ action: "OFFSCREEN_STOP" }).catch(() => undefined);
        await setError(toMessage(error));
        throw error;
    } finally {
        starting = false;
    }
}

async function stopCapture(reason, isError) {
    await sendRuntimeMessage({ action: "OFFSCREEN_STOP" }).catch(() => undefined);
    const nextLifecycle = isError ? "Error" : "Stopped";
    await updateState({
        lifecycle: nextLifecycle,
        deepgram: "Disconnected",
        translator: "Disconnected",
        error: isError ? reason : "",
        capturingTabId: null,
        startedAt: null
    });
    await captureFullscreen.stop();
    await broadcastToPopup({
        action: "STATUS_UPDATE",
        state
    });
    if (isError) {
        await broadcastToAllTabs({
            action: "PIPELINE_STATUS",
            status: nextLifecycle,
            error: reason
        });
    }
}

async function handlePipelineEvent(event) {
    if (!event || typeof event.type !== "string") {
        return;
    }

    switch (event.type) {
        case "STATE":
            await updateState(event.patch || {});
            await sendToCapturedTab({
                action: "PIPELINE_STATUS",
                status: state.lifecycle,
                error: state.error
            });
            break;
        case "SUBTITLE":
            await sendToCapturedTab(event.payload);
            break;
        case "DEBUG":
            state.debug = { ...state.debug, ...(event.data || {}) };
            await persistState();
            break;
        case "ERROR":
            await setError(event.message || "Unknown pipeline error.");
            break;
        default:
            return;
    }

    await broadcastToPopup({
        action: "STATUS_UPDATE",
        state
    });
}

async function updateSettings(settings) {
    if (!settings || typeof settings !== "object") {
        return;
    }
    const stored = await chrome.storage.local.get("subtitleSettings");
    const merged = {
        ...(stored.subtitleSettings || {}),
        ...settings
    };
    await chrome.storage.local.set({ subtitleSettings: merged });
    await sendRuntimeMessage({
        action: "OFFSCREEN_SETTINGS",
        settings: merged
    }).catch(() => undefined);
    await broadcastToAllTabs({
        action: "SETTINGS_UPDATE",
        settings: merged
    });
}

async function restrictStorageToExtensionContexts() {
    await Promise.all([
        chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" }),
        chrome.storage.session.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" })
    ]);
}

function createDefaultApiSettings() {
    return {
        deepgram: { storageMode: "session" },
        gemini: { storageMode: "session" },
        customLlm: {
            displayName: "Custom LLM",
            baseUrl: "",
            model: "",
            storageMode: "session"
        }
    };
}

async function buildProviderConfig(speechProfileId, translationProfileId, apiSettings) {
    const speechProfile = CONFIG.deepgram.profiles[speechProfileId];
    const translationProfile = CONFIG.translation.profiles[translationProfileId];
    if (!speechProfile || !translationProfile) {
        throw new Error("Choose a supported speech and translation model.");
    }

    const settings = {
        ...createDefaultApiSettings(),
        ...(apiSettings || {}),
        customLlm: {
            ...createDefaultApiSettings().customLlm,
            ...(apiSettings?.customLlm || {})
        }
    };
    const localStored = await chrome.storage.local.get("apiCredentials");
    const sessionStored = await chrome.storage.session.get("apiCredentials");
    const localCredentials = localStored.apiCredentials || {};
    const sessionCredentials = sessionStored.apiCredentials || {};
    const readKey = (id) => settings[id]?.storageMode === "device"
        ? localCredentials[id] || ""
        : sessionCredentials[id] || "";

    const needsDeepgram = speechProfile.provider === "deepgram";
    const needsGemini = speechProfile.provider === "gemini-transcribe"
        || translationProfile.provider === "gemini";
    const needsCustom = translationProfile.provider === "custom-llm";
    const providerConfig = {
        deepgramApiKey: needsDeepgram ? readKey("deepgram") : "",
        geminiApiKey: needsGemini ? readKey("gemini") : "",
        customLlm: needsCustom
            ? {
                ...settings.customLlm,
                apiKey: readKey("customLlm")
            }
            : null
    };

    if (needsDeepgram && !providerConfig.deepgramApiKey.trim()) {
        throw new Error("Deepgram API key is missing. Add it in API Settings.");
    }
    if (needsGemini && !providerConfig.geminiApiKey.trim()) {
        throw new Error("Gemini API key is missing. Add it in API Settings.");
    }
    if (needsCustom) {
        const baseUrl = String(providerConfig.customLlm.baseUrl || "").trim();
        const model = String(providerConfig.customLlm.model || "").trim();
        if (!baseUrl || !model) {
            throw new Error("Custom LLM URL and model are required. Add them in API Settings.");
        }
        let url;
        try {
            url = new URL(baseUrl);
        } catch {
            throw new Error("Custom LLM Base URL is invalid.");
        }
        if (!(["http:", "https:"].includes(url.protocol))
            || url.username || url.password || url.search || url.hash) {
            throw new Error("Custom LLM Base URL must use http or https and contain no credentials, query, or fragment.");
        }
        const originPattern = `${url.origin}/*`;
        const granted = await chrome.permissions.contains({ origins: [originPattern] });
        if (!granted) {
            throw new Error(`Grant Chrome permission to connect to ${url.origin} in API Settings first.`);
        }
    }

    return providerConfig;
}

async function ensureOffscreenDocument() {
    const contexts = await getOffscreenContexts();
    if (contexts.length > 0) {
        return;
    }

    await chrome.offscreen.createDocument({
        url: OFFSCREEN_DOCUMENT_PATH,
        reasons: ["USER_MEDIA"],
        justification: "Capture and process the selected tab audio for live subtitles."
    });
}

async function ensureContentScript(tabId) {
    try {
        const response = await chrome.tabs.sendMessage(tabId, { action: "PING" });
        if (response?.ok) {
            return;
        }
    } catch {
        // The declared content script may not have run yet.
    }

    await chrome.scripting.executeScript({
        target: { tabId },
        files: [
            "content/subtitle-overlay.js",
            "content/content-script.js"
        ]
    });
    const response = await chrome.tabs.sendMessage(tabId, { action: "PING" });
    if (!response?.ok) {
        throw new Error("The subtitle content script could not be initialized.");
    }
}

function getMediaStreamId(tabId) {
    return new Promise((resolve, reject) => {
        chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, (streamId) => {
            if (chrome.runtime.lastError) {
                reject(new Error(`Cannot capture tab: ${chrome.runtime.lastError.message}`));
                return;
            }
            if (!streamId) {
                reject(new Error("Cannot capture tab: Chrome returned an empty stream ID."));
                return;
            }
            resolve(streamId);
        });
    });
}

async function syncStateFromOffscreen() {
    try {
        const contexts = await getOffscreenContexts();
        if (contexts.length === 0) {
            if (isCaptureActive()) {
                state = {
                    ...state,
                    lifecycle: "Error",
                    deepgram: "Disconnected",
                    translator: "Disconnected",
                    error: "The offscreen document is unavailable.",
                    capturingTabId: null,
                    startedAt: null
                };
                await persistState();
            }
            return;
        }
        const response = await sendRuntimeMessage({ action: "OFFSCREEN_GET_STATUS" });
        if (response?.ok && response.state) {
            state = { ...state, ...response.state };
            await persistState();
        }
    } catch {
        if (isCaptureActive()) {
            state = {
                ...state,
                lifecycle: "Error",
                error: "The offscreen document is unavailable.",
                capturingTabId: null
            };
            await persistState();
        }
    }
}

function getOffscreenContexts() {
    return chrome.runtime.getContexts({
        contextTypes: ["OFFSCREEN_DOCUMENT"],
        documentUrls: [chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH)]
    });
}

async function sendToCapturedTab(message) {
    if (!Number.isInteger(state.capturingTabId)) {
        return;
    }
    try {
        await chrome.tabs.sendMessage(state.capturingTabId, message);
    } catch (error) {
        console.warn("Content script message failed:", error);
        try {
            await ensureContentScript(state.capturingTabId);
            await chrome.tabs.sendMessage(state.capturingTabId, message);
        } catch (retryError) {
            console.warn("Content script reinjection failed:", retryError);
        }
    }
}

async function clearSubtitles() {
    // The overlay remains after Stop, so its tab must outlive the capture state.
    let tabId = state.capturingTabId ?? state.subtitleTabId;
    if (!Number.isInteger(tabId)) {
        // Also support subtitles left by a capture started before this update.
        const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        tabId = tab?.id;
    }
    if (!Number.isInteger(tabId)) {
        throw new Error("No subtitle tab is available.");
    }
    await chrome.tabs.sendMessage(tabId, { action: "CLEAR_SUBTITLES" });
}

async function broadcastToAllTabs(message) {
    const tabs = await chrome.tabs.query({});
    await Promise.allSettled(
        tabs
            .filter((tab) => Number.isInteger(tab.id))
            .map((tab) => chrome.tabs.sendMessage(tab.id, message))
    );
}

async function broadcastToPopup(message) {
    await sendRuntimeMessage(message).catch(() => undefined);
}

async function updateState(patch) {
    state = { ...state, ...patch };
    await persistState();
}

async function setError(message) {
    console.warn("Capture stopped after a handled error:", message);
    await sendToCapturedTab({
        action: "PIPELINE_STATUS",
        status: "Error",
        error: message
    });
    await updateState({
        lifecycle: "Error",
        error: message,
        capturingTabId: null,
        startedAt: null
    });
    await captureFullscreen.stop();
    await broadcastToPopup({
        action: "STATUS_UPDATE",
        state
    });
}

async function restoreState() {
    const stored = await chrome.storage.session.get("runtimeState");
    state = { ...DEFAULT_STATE, ...(stored.runtimeState || {}) };
}

async function persistState() {
    await chrome.storage.session.set({ runtimeState: state });
}

function sendRuntimeMessage(message) {
    return chrome.runtime.sendMessage(message);
}

function isCaptureActive() {
    return Number.isInteger(state.capturingTabId)
        && !["Idle", "Stopped", "Error"].includes(state.lifecycle);
}

function isPopupSender(sender) {
    return sender.id === chrome.runtime.id
        && sender.url === chrome.runtime.getURL("popup/popup.html");
}

function isOffscreenSender(sender) {
    return sender.id === chrome.runtime.id
        && sender.url === chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH);
}

function isSupportedTabUrl(url) {
    return typeof url === "string"
        && (url.startsWith("http://") || url.startsWith("https://"));
}

function toMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
