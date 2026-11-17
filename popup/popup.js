import { CONFIG } from "../config.js";

const DEFAULT_SETTINGS = {
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
};

const DEFAULT_API_SETTINGS = {
    deepgram: { storageMode: "session" },
    gemini: { storageMode: "session" },
    customLlm: {
        displayName: "Custom LLM",
        baseUrl: "",
        model: "",
        storageMode: "session"
    }
};

const PROVIDERS = ["deepgram", "gemini", "customLlm"];
const API_SETTINGS_KEY = "apiSettings";
const API_CREDENTIALS_KEY = "apiCredentials";

const elements = {
    connectionStatus: document.getElementById("connection-status"),
    deepgramStatus: document.getElementById("deepgram-status"),
    translatorStatus: document.getElementById("translator-status"),
    errorMessage: document.getElementById("error-message"),
    configurationWarning: document.getElementById("configuration-warning"),
    configurationWarningText: document.getElementById("configuration-warning-text"),
    openApiSettings: document.getElementById("open-api-settings"),
    startButton: document.getElementById("start-button"),
    stopButton: document.getElementById("stop-button"),
    clearButton: document.getElementById("clear-button"),
    deepgramProfile: document.getElementById("deepgram-profile"),
    translationProfile: document.getElementById("translation-profile"),
    translationHint: document.getElementById("translation-hint"),
    fontSize: document.getElementById("font-size"),
    fontSizeValue: document.getElementById("font-size-value"),
    subtitleWidth: document.getElementById("subtitle-width"),
    subtitleWidthValue: document.getElementById("subtitle-width-value"),
    backgroundOpacity: document.getElementById("background-opacity"),
    backgroundOpacityValue: document.getElementById("background-opacity-value"),
    backgroundColor: document.getElementById("background-color"),
    englishColor: document.getElementById("english-color"),
    chineseColor: document.getElementById("chinese-color"),
    resetPosition: document.getElementById("reset-position"),
    showEnglish: document.getElementById("show-english"),
    showChinese: document.getElementById("show-chinese"),
    debugMode: document.getElementById("debug-mode"),
    debugPanel: document.getElementById("debug-panel"),
    debugOutput: document.getElementById("debug-output"),
    subtitlePreview: document.getElementById("subtitle-preview"),
    previewEnglish: document.querySelector(".preview-english"),
    previewChinese: document.querySelector(".preview-chinese")
};

let currentState = null;
let settings = { ...DEFAULT_SETTINGS };
let apiSettings = structuredClone(DEFAULT_API_SETTINGS);
let settingsTimer = null;
let storedCredentialFlags = { deepgram: false, gemini: false, customLlm: false };
let apiStatusReady = false;

for (const tabButton of document.querySelectorAll("[role='tab']")) {
    tabButton.addEventListener("click", () => selectTab(tabButton));
}

elements.openApiSettings.addEventListener("click", () => {
    selectTab(document.getElementById("tab-api-button"));
});

elements.startButton.addEventListener("click", async () => {
    setBusy(true);
    clearLocalError();
    try {
        await ensureProviderPermissions();
        const response = await chrome.runtime.sendMessage({
            action: "START_CAPTURE",
            deepgramProfile: elements.deepgramProfile.value,
            translationProfile: elements.translationProfile.value
        });
        if (!response?.ok) {
            throw new Error(response?.error || "Capture could not be started.");
        }
        renderState(response.state);
    } catch (error) {
        showLocalError(toMessage(error));
    } finally {
        setBusy(false);
        await refreshStatus();
    }
});

elements.stopButton.addEventListener("click", async () => {
    setBusy(true);
    try {
        const response = await chrome.runtime.sendMessage({ action: "STOP_CAPTURE" });
        if (!response?.ok) {
            throw new Error(response?.error || "Capture could not be stopped.");
        }
        renderState(response.state);
    } catch (error) {
        showLocalError(toMessage(error));
    } finally {
        setBusy(false);
        await refreshStatus();
    }
});

elements.clearButton.addEventListener("click", async () => {
    const response = await chrome.runtime.sendMessage({ action: "CLEAR_SUBTITLES" });
    if (!response?.ok) {
        showLocalError(response?.error || "Subtitles could not be cleared.");
    }
});

for (const range of [elements.fontSize, elements.subtitleWidth, elements.backgroundOpacity]) {
    range.addEventListener("input", () => {
        renderAppearancePreview();
        scheduleSettingsUpdate();
    });
}

for (const color of [elements.backgroundColor, elements.englishColor, elements.chineseColor]) {
    color.addEventListener("input", () => {
        renderAppearancePreview();
        scheduleSettingsUpdate();
    });
}

elements.resetPosition.addEventListener("click", () => {
    settings.position = null;
    scheduleSettingsUpdate();
});

elements.deepgramProfile.addEventListener("change", () => {
    updateTranslationHint();
    updateConfigurationWarning();
    scheduleSettingsUpdate();
});

elements.translationProfile.addEventListener("change", () => {
    updateConfigurationWarning();
    scheduleSettingsUpdate();
});

for (const checkbox of [elements.showEnglish, elements.showChinese, elements.debugMode]) {
    checkbox.addEventListener("change", () => {
        renderAppearancePreview();
        scheduleSettingsUpdate();
    });
}

for (const button of document.querySelectorAll("[data-save-provider]")) {
    button.addEventListener("click", () => saveProvider(button.dataset.saveProvider));
}
for (const button of document.querySelectorAll("[data-remove-provider]")) {
    button.addEventListener("click", () => removeProvider(button.dataset.removeProvider));
}
for (const button of document.querySelectorAll("[data-test-provider]")) {
    button.addEventListener("click", () => testProvider(button.dataset.testProvider));
}
for (const button of document.querySelectorAll("[data-reveal]")) {
    button.addEventListener("click", () => toggleSecretVisibility(button));
}

for (const input of document.querySelectorAll("#customLlm-name, #customLlm-base-url, #customLlm-model, .provider-card input[type='password']")) {
    input.addEventListener("input", () => {
        const providerId = input.closest("[data-provider]")?.dataset.provider;
        if (providerId) {
            setProviderResult(providerId, "尚未儲存或測試", "");
        }
    });
}

chrome.runtime.onMessage.addListener((message) => {
    if (message?.action === "STATUS_UPDATE") {
        renderState(message.state);
    }
});

async function initialize() {
    await restrictStorageToExtensionContexts();
    populateSpeechProfiles();
    populateTranslationProfiles();
    const stored = await chrome.storage.local.get(["subtitleSettings", API_SETTINGS_KEY]);
    settings = {
        ...DEFAULT_SETTINGS,
        ...(stored.subtitleSettings || {})
    };
    if (settings.translationProfile === "local-gemma") {
        settings.translationProfile = "custom-llm";
    }
    apiSettings = mergeApiSettings(stored.apiSettings);
    populateTranslationProfiles();
    renderSettings();
    renderApiSettings();
    await refreshApiKeyStatuses();
    await refreshStatus();
}

async function restrictStorageToExtensionContexts() {
    await Promise.all([
        chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" }),
        chrome.storage.session.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" })
    ]);
}

function mergeApiSettings(value) {
    const merged = {
        ...structuredClone(DEFAULT_API_SETTINGS),
        ...(value || {}),
        deepgram: { ...DEFAULT_API_SETTINGS.deepgram, ...(value?.deepgram || {}) },
        gemini: { ...DEFAULT_API_SETTINGS.gemini, ...(value?.gemini || {}) },
        customLlm: { ...DEFAULT_API_SETTINGS.customLlm, ...(value?.customLlm || {}) }
    };
    for (const providerId of PROVIDERS) {
        merged[providerId].storageMode = merged[providerId].storageMode === "device"
            ? "device"
            : "session";
    }
    return merged;
}

async function refreshStatus() {
    try {
        const response = await chrome.runtime.sendMessage({ action: "GET_STATUS" });
        if (response?.ok) {
            renderState(response.state);
        }
    } catch (error) {
        showLocalError(`Status unavailable: ${toMessage(error)}`);
    }
}

async function ensureProviderPermissions() {
    const speechProfile = CONFIG.deepgram.profiles[elements.deepgramProfile.value];
    const translationProfile = CONFIG.translation.profiles[elements.translationProfile.value];
    if (!speechProfile || !translationProfile) {
        throw new Error("Choose a supported speech and translation model.");
    }
    if (!apiStatusReady) {
        throw new Error("API settings are still loading. Please try again.");
    }
    if (speechProfile.provider === "deepgram" && !storedCredentialFlags.deepgram) {
        switchToApiSettings("請先設定 Deepgram API key。");
        throw new Error("Deepgram API key is missing. Add it in API Settings.");
    }
    if ((speechProfile.provider === "gemini-transcribe"
        || translationProfile.provider === "gemini")
        && !storedCredentialFlags.gemini) {
        switchToApiSettings("請先設定 Gemini API key。");
        throw new Error("Gemini API key is missing. Add it in API Settings.");
    }
    let customPermissionPromise = null;
    let customOrigin = "";
    if (translationProfile.provider === "custom-llm") {
        const config = apiSettings.customLlm;
        validateCustomLlmSettings(config);
        customOrigin = new URL(config.baseUrl).origin;
        customPermissionPromise = chrome.permissions.request({
            origins: [`${customOrigin}/*`]
        });
    }
    if (customPermissionPromise) {
        const granted = await customPermissionPromise;
        if (!granted) {
            throw new Error(`Permission to connect to ${customOrigin} was not granted.`);
        }
    }
}

function populateSpeechProfiles() {
    const fragment = document.createDocumentFragment();
    for (const [id, profile] of Object.entries(CONFIG.deepgram.profiles)) {
        const option = document.createElement("option");
        option.value = id;
        option.textContent = profile.label || id;
        fragment.appendChild(option);
    }
    elements.deepgramProfile.replaceChildren(fragment);
}

function populateTranslationProfiles() {
    const selected = elements.translationProfile.value || settings.translationProfile;
    const fragment = document.createDocumentFragment();
    for (const [id, profile] of Object.entries(CONFIG.translation.profiles)) {
        const option = document.createElement("option");
        option.value = id;
        option.textContent = profile.provider === "custom-llm"
            ? apiSettings.customLlm.displayName || "Custom LLM"
            : profile.label || id;
        fragment.appendChild(option);
    }
    elements.translationProfile.replaceChildren(fragment);
    if (CONFIG.translation.profiles[selected]) {
        elements.translationProfile.value = selected;
    }
}

function renderSettings() {
    const speechProfile = CONFIG.deepgram.profiles[settings.deepgramProfile]
        ? settings.deepgramProfile
        : CONFIG.deepgram.defaultProfile;
    settings.deepgramProfile = speechProfile;
    elements.deepgramProfile.value = speechProfile;

    const translationProfile = CONFIG.translation.profiles[settings.translationProfile]
        ? settings.translationProfile
        : CONFIG.translation.defaultProfile;
    settings.translationProfile = translationProfile;
    elements.translationProfile.value = translationProfile;
    updateTranslationHint();

    elements.fontSize.value = String(settings.fontSize);
    elements.fontSizeValue.textContent = `${settings.fontSize} px`;
    elements.subtitleWidth.value = String(settings.width);
    elements.subtitleWidthValue.textContent = `${settings.width} px`;
    elements.backgroundOpacity.value = String(settings.backgroundOpacity);
    elements.backgroundOpacityValue.textContent = `${settings.backgroundOpacity}%`;
    elements.backgroundColor.value = normalizeColor(settings.backgroundColor, "#000000");
    elements.englishColor.value = normalizeColor(settings.englishColor, "#ffffff");
    elements.chineseColor.value = normalizeColor(settings.chineseColor, "#fff3a6");
    elements.showEnglish.checked = Boolean(settings.showEnglish);
    elements.showChinese.checked = Boolean(settings.showChinese);
    elements.debugMode.checked = Boolean(settings.debugMode);
    elements.debugPanel.hidden = !settings.debugMode;
    renderAppearancePreview();
}

function renderApiSettings() {
    document.getElementById("deepgram-storage").value = apiSettings.deepgram.storageMode;
    document.getElementById("gemini-storage").value = apiSettings.gemini.storageMode;
    document.getElementById("customLlm-storage").value = apiSettings.customLlm.storageMode;
    document.getElementById("customLlm-name").value = apiSettings.customLlm.displayName || "Custom LLM";
    document.getElementById("customLlm-base-url").value = apiSettings.customLlm.baseUrl || "";
    document.getElementById("customLlm-model").value = apiSettings.customLlm.model || "";
}

function renderAppearancePreview() {
    const size = Number(elements.fontSize.value);
    const width = Number(elements.subtitleWidth.value);
    const opacity = Number(elements.backgroundOpacity.value) / 100;
    elements.fontSizeValue.textContent = `${size} px`;
    elements.subtitleWidthValue.textContent = `${width} px`;
    elements.backgroundOpacityValue.textContent = `${Math.round(opacity * 100)}%`;
    elements.subtitlePreview.style.width = `min(100%, ${Math.round(width / 3)}px)`;
    elements.subtitlePreview.style.backgroundColor = colorWithOpacity(
        elements.backgroundColor.value,
        opacity
    );
    elements.previewEnglish.style.fontSize = `${Math.max(12, Math.round(size * 0.39))}px`;
    elements.previewChinese.style.fontSize = `${Math.max(14, Math.round(size * 0.5))}px`;
    elements.previewEnglish.style.color = elements.englishColor.value;
    elements.previewChinese.style.color = elements.chineseColor.value;
    elements.previewEnglish.hidden = !elements.showEnglish.checked;
    elements.previewChinese.hidden = !elements.showChinese.checked;
}

function updateTranslationHint() {
    const geminiTranscribe = CONFIG.deepgram.profiles[elements.deepgramProfile.value]
        ?.provider === "gemini-transcribe";
    elements.translationHint.textContent = geminiTranscribe
        ? "Translates Gemini Transcribe text into Traditional Chinese."
        : "Translates speech transcripts into Traditional Chinese.";
}

function scheduleSettingsUpdate() {
    clearTimeout(settingsTimer);
    settingsTimer = setTimeout(async () => {
        settings = {
            ...settings,
            fontSize: Number(elements.fontSize.value),
            width: Number(elements.subtitleWidth.value),
            backgroundOpacity: Number(elements.backgroundOpacity.value),
            backgroundColor: elements.backgroundColor.value,
            englishColor: elements.englishColor.value,
            chineseColor: elements.chineseColor.value,
            deepgramProfile: elements.deepgramProfile.value,
            translationProfile: elements.translationProfile.value,
            showEnglish: elements.showEnglish.checked,
            showChinese: elements.showChinese.checked,
            debugMode: elements.debugMode.checked
        };
        const response = await chrome.runtime.sendMessage({
            action: "UPDATE_SETTINGS",
            settings
        });
        if (!response?.ok) {
            showLocalError(response?.error || "Settings could not be saved.");
        }
        await updateConfigurationWarning();
    }, 120);
}

async function updateConfigurationWarning() {
    const speechProfile = CONFIG.deepgram.profiles[elements.deepgramProfile.value];
    const translationProfile = CONFIG.translation.profiles[elements.translationProfile.value];
    const missing = [];
    if (speechProfile?.provider === "deepgram" && !storedCredentialFlags.deepgram) {
        missing.push("Deepgram API key");
    }
    if ((speechProfile?.provider === "gemini-transcribe"
        || translationProfile?.provider === "gemini")
        && !storedCredentialFlags.gemini) {
        missing.push("Gemini API key");
    }
    if (translationProfile?.provider === "custom-llm") {
        if (!String(apiSettings.customLlm.baseUrl || "").trim()
            || !String(apiSettings.customLlm.model || "").trim()) {
            missing.push("Custom LLM URL and Model ID");
        }
    }
    const active = isCaptureActive();
    elements.configurationWarning.hidden = missing.length === 0 || active;
    elements.configurationWarningText.textContent = missing.length
        ? `尚未完成設定：${missing.join("、")}。`
        : "";
    elements.startButton.disabled = active || missing.length > 0;
    await updateProviderControls();
}

function renderState(state) {
    if (!state) return;
    currentState = state;
    elements.connectionStatus.textContent = state.lifecycle || "Idle";
    elements.deepgramStatus.textContent = state.deepgram || "Disconnected";
    elements.translatorStatus.textContent = state.translator || "Not checked";
    if (state.error) {
        elements.errorMessage.hidden = false;
        elements.errorMessage.textContent = state.error;
    } else {
        clearLocalError();
    }
    const active = isCaptureActive();
    elements.stopButton.disabled = !active;
    elements.deepgramProfile.disabled = active;
    elements.translationProfile.disabled = active;
    if (settings.debugMode && state.debug?.lastEvent) {
        elements.debugOutput.textContent = JSON.stringify(state.debug.lastEvent, null, 2);
    }
    void updateConfigurationWarning();
}

function isCaptureActive() {
    return Number.isInteger(currentState?.capturingTabId)
        && !["Idle", "Stopped", "Error"].includes(currentState.lifecycle);
}

async function refreshApiKeyStatuses() {
    for (const providerId of PROVIDERS) {
        const key = await getStoredCredential(providerId);
        storedCredentialFlags[providerId] = Boolean(key);
        const status = document.getElementById(`${providerId}-key-status`);
        const mode = apiSettings[providerId].storageMode;
        status.textContent = key
            ? `已設定 · ${mode === "device" ? "此裝置" : "本次工作階段"}`
            : "尚未設定";
        status.classList.toggle("configured", Boolean(key));
    }
    apiStatusReady = true;
    await updateConfigurationWarning();
}

async function updateProviderControls() {
    const disabled = isCaptureActive();
    for (const button of document.querySelectorAll("[data-save-provider], [data-remove-provider], [data-test-provider]")) {
        button.disabled = disabled;
    }
    for (const select of document.querySelectorAll(".storage-mode")) {
        select.disabled = disabled;
    }
    for (const input of document.querySelectorAll(".provider-card input")) {
        input.disabled = disabled;
    }
}

async function saveProvider(providerId) {
    if (!PROVIDERS.includes(providerId) || isCaptureActive()) return;
    const button = document.querySelector(`[data-save-provider="${providerId}"]`);
    button.disabled = true;
    setProviderResult(providerId, "儲存中…", "");
    try {
        const currentApiSettings = mergeApiSettings(
            (await chrome.storage.local.get(API_SETTINGS_KEY)).apiSettings
        );
        const nextApiSettings = structuredClone(currentApiSettings);
        nextApiSettings[providerId].storageMode = document.getElementById(`${providerId}-storage`).value;
        if (providerId === "customLlm") {
            nextApiSettings.customLlm.displayName = document.getElementById("customLlm-name").value.trim() || "Custom LLM";
            nextApiSettings.customLlm.baseUrl = document.getElementById("customLlm-base-url").value.trim();
            nextApiSettings.customLlm.model = document.getElementById("customLlm-model").value.trim();
        }

        const typedKey = document.getElementById(`${providerId}-key`).value.trim();
        const key = typedKey || await getAnyStoredCredential(providerId);
        await writeCredential(providerId, key, nextApiSettings[providerId].storageMode);
        await chrome.storage.local.set({ [API_SETTINGS_KEY]: nextApiSettings });
        apiSettings = nextApiSettings;
        document.getElementById(`${providerId}-key`).value = "";
        if (providerId === "customLlm") populateTranslationProfiles();
        renderApiSettings();
        setProviderResult(providerId, "設定已儲存。", "success");
        await refreshApiKeyStatuses();
    } catch (error) {
        setProviderResult(providerId, toMessage(error), "failure");
    } finally {
        button.disabled = isCaptureActive();
    }
}

async function removeProvider(providerId) {
    if (!PROVIDERS.includes(providerId) || isCaptureActive()) return;
    const button = document.querySelector(`[data-remove-provider="${providerId}"]`);
    button.disabled = true;
    try {
        await writeCredential(providerId, "", "session");
        document.getElementById(`${providerId}-key`).value = "";
        setProviderResult(providerId, "API key 已移除。", "success");
        await refreshApiKeyStatuses();
    } catch (error) {
        setProviderResult(providerId, toMessage(error), "failure");
    } finally {
        button.disabled = isCaptureActive();
    }
}

async function testProvider(providerId) {
    if (!PROVIDERS.includes(providerId) || isCaptureActive()) return;
    const button = document.querySelector(`[data-test-provider="${providerId}"]`);
    button.disabled = true;
    setProviderResult(providerId, "測試連線中…", "");
    try {
        const typedKey = document.getElementById(`${providerId}-key`).value.trim();
        let custom = null;
        let customOriginPermission = null;
        if (providerId === "customLlm") {
            custom = readCustomLlmForm();
            validateCustomLlmSettings(custom);
            const origin = new URL(custom.baseUrl).origin;
            customOriginPermission = chrome.permissions.request({
                origins: [`${origin}/*`]
            });
        }
        const key = typedKey || await getAnyStoredCredential(providerId);
        if (providerId !== "customLlm" && !key) {
            throw new Error("請先輸入並儲存 API key，或在欄位中暫時輸入 key 再測試。");
        }

        let url;
        let init;
        if (providerId === "deepgram") {
            url = "https://api.deepgram.com/v1/projects";
            init = { headers: { Authorization: `Token ${key}` } };
        } else if (providerId === "gemini") {
            url = "https://generativelanguage.googleapis.com/v1beta/models";
            init = { headers: { "x-goog-api-key": key } };
        } else {
            const parsedUrl = new URL(custom.baseUrl);
            const granted = await customOriginPermission;
            if (!granted) throw new Error(`Permission to connect to ${parsedUrl.origin} was not granted.`);
            url = getCustomLlmEndpoint(custom.baseUrl);
            const headers = { "Content-Type": "application/json" };
            if (key) headers.Authorization = `Bearer ${key}`;
            init = {
                method: "POST",
                headers,
                body: JSON.stringify({
                    model: custom.model,
                    temperature: 0,
                    max_tokens: 1,
                    stream: false,
                    messages: [{ role: "user", content: "Reply with OK." }]
                })
            };
        }

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 12000);
        let response;
        try {
            response = await fetch(url, { ...init, signal: controller.signal });
        } finally {
            clearTimeout(timeout);
        }
        if (!response.ok) {
            throw new Error(`服務回應 HTTP ${response.status}。請確認 key、模型權限與服務端點。`);
        }
        setProviderResult(providerId, "連線成功。", "success");
    } catch (error) {
        const message = error?.name === "AbortError"
            ? "連線逾時。"
            : error instanceof TypeError
                ? "無法連線。請檢查 URL、CORS、網路與主機權限。"
                : toMessage(error);
        setProviderResult(providerId, message, "failure");
    } finally {
        button.disabled = isCaptureActive();
    }
}

function readCustomLlmForm() {
    return {
        displayName: document.getElementById("customLlm-name").value.trim() || "Custom LLM",
        baseUrl: document.getElementById("customLlm-base-url").value.trim(),
        model: document.getElementById("customLlm-model").value.trim()
    };
}

function validateCustomLlmSettings(config) {
    if (!String(config.baseUrl || "").trim() || !String(config.model || "").trim()) {
        throw new Error("請填寫 Custom LLM Base URL 與 Model ID。");
    }
    let url;
    try {
        url = new URL(config.baseUrl);
    } catch {
        throw new Error("Custom LLM Base URL 格式無效。");
    }
    if (!["http:", "https:"].includes(url.protocol)
        || url.username || url.password || url.search || url.hash) {
        throw new Error("Custom LLM URL 必須使用 http 或 https，且不能含帳密、查詢參數或片段。");
    }
}

function getCustomLlmEndpoint(baseUrl) {
    const normalized = String(baseUrl || "").trim().replace(/\/+$/, "");
    return normalized.endsWith("/chat/completions")
        ? normalized
        : `${normalized}/chat/completions`;
}

function setProviderResult(providerId, text, state) {
    const result = document.getElementById(`${providerId}-result`);
    result.textContent = text;
    result.classList.remove("success", "failure");
    if (state) result.classList.add(state);
}

async function getStoredCredential(providerId) {
    const mode = apiSettings[providerId]?.storageMode === "device" ? "device" : "session";
    const source = mode === "device" ? chrome.storage.local : chrome.storage.session;
    const stored = await source.get(API_CREDENTIALS_KEY);
    return String(stored.apiCredentials?.[providerId] || "").trim();
}

async function getAnyStoredCredential(providerId) {
    const [local, session] = await Promise.all([
        chrome.storage.local.get(API_CREDENTIALS_KEY),
        chrome.storage.session.get(API_CREDENTIALS_KEY)
    ]);
    return String(
        local.apiCredentials?.[providerId]
        || session.apiCredentials?.[providerId]
        || ""
    ).trim();
}

async function writeCredential(providerId, key, storageMode) {
    const [local, session] = await Promise.all([
        chrome.storage.local.get(API_CREDENTIALS_KEY),
        chrome.storage.session.get(API_CREDENTIALS_KEY)
    ]);
    const localCredentials = { ...(local.apiCredentials || {}) };
    const sessionCredentials = { ...(session.apiCredentials || {}) };
    delete localCredentials[providerId];
    delete sessionCredentials[providerId];
    if (key) {
        const target = storageMode === "device" ? localCredentials : sessionCredentials;
        target[providerId] = key;
    }
    const persist = async (area, credentials) => {
        if (Object.keys(credentials).length) {
            await area.set({ [API_CREDENTIALS_KEY]: credentials });
        } else {
            await area.remove(API_CREDENTIALS_KEY);
        }
    };
    await Promise.all([
        persist(chrome.storage.local, localCredentials),
        persist(chrome.storage.session, sessionCredentials)
    ]);
}

function toggleSecretVisibility(button) {
    const input = document.getElementById(button.dataset.reveal);
    const visible = input.type === "password";
    input.type = visible ? "text" : "password";
    button.textContent = visible ? "隱藏" : "顯示";
    button.setAttribute("aria-label", `${visible ? "隱藏" : "顯示"} ${input.id} API key`);
}

function selectTab(tabButton) {
    for (const button of document.querySelectorAll("[role='tab']")) {
        const selected = button === tabButton;
        button.classList.toggle("active", selected);
        button.setAttribute("aria-selected", String(selected));
        document.getElementById(button.getAttribute("aria-controls")).hidden = !selected;
    }
}

function switchToApiSettings(message) {
    selectTab(document.getElementById("tab-api-button"));
    showLocalError(message);
}

function setBusy(busy) {
    if (busy) {
        elements.startButton.disabled = true;
        elements.stopButton.disabled = true;
        elements.deepgramProfile.disabled = true;
        elements.translationProfile.disabled = true;
        return;
    }
    renderState(currentState || {
        lifecycle: "Idle",
        deepgram: "Disconnected",
        translator: "Not checked"
    });
}

function showLocalError(message) {
    elements.errorMessage.hidden = false;
    elements.errorMessage.textContent = message;
}

function clearLocalError() {
    elements.errorMessage.hidden = true;
    elements.errorMessage.textContent = "";
}

function toMessage(error) {
    return error instanceof Error ? error.message : String(error);
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

void initialize().catch((error) => showLocalError(toMessage(error)));
