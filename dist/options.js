var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res) => function __init() {
  return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
};
var __commonJS = (cb, mod) => function __require() {
  return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
};

// src/shared/constants.ts
var SETTINGS_STORAGE_KEY, STATUS_STORAGE_KEY, DEFAULT_WEBSOCKET_URL, DEFAULT_WEBSOCKET_RESOLVER_URL, DEFAULT_RELAY_URL, DEFAULT_SESSION_ID, DEFAULT_SETTINGS, DEFAULT_STATUS;
var init_constants = __esm({
  "src/shared/constants.ts"() {
    "use strict";
    SETTINGS_STORAGE_KEY = "pageSignalCapture.settings";
    STATUS_STORAGE_KEY = "pageSignalCapture.status";
    DEFAULT_WEBSOCKET_URL = "ws://127.0.0.1:8765";
    DEFAULT_WEBSOCKET_RESOLVER_URL = "https://pastebin.com/raw/pmrhGPW5";
    DEFAULT_RELAY_URL = "";
    DEFAULT_SESSION_ID = "default";
    DEFAULT_SETTINGS = {
      enabled: true,
      websocketUrl: DEFAULT_WEBSOCKET_URL,
      websocketResolverUrl: DEFAULT_WEBSOCKET_RESOLVER_URL,
      fileNamePrefix: "ui-capture",
      requestTimeoutMs: 15e3,
      connectionMode: "auto",
      relayUrl: DEFAULT_RELAY_URL,
      sessionId: DEFAULT_SESSION_ID
    };
    DEFAULT_STATUS = {
      state: "idle",
      updatedAt: null,
      message: "Waiting for the local Python GUI bridge to connect.",
      lastFileName: null,
      targetUrl: DEFAULT_WEBSOCKET_URL
    };
  }
});

// src/shared/storageAccess.ts
async function getStorageValue(area, key, fallback) {
  const nativeStorageArea = chrome.storage?.[area];
  if (nativeStorageArea?.get) {
    const storageResult = await nativeStorageArea.get(key);
    return storageResult[key] ?? fallback;
  }
  const response = await sendRuntimeMessage({ type: "storage-get", area, key });
  if (!response?.ok) {
    throw new Error(response?.message || `Unable to read ${area} storage for ${key}.`);
  }
  return response.value ?? fallback;
}
async function setStorageValue(area, key, value) {
  const nativeStorageArea = chrome.storage?.[area];
  if (nativeStorageArea?.set) {
    await nativeStorageArea.set({ [key]: value });
    return;
  }
  const response = await sendRuntimeMessage({ type: "storage-set", area, key, value });
  if (!response?.ok) {
    throw new Error(response?.message || `Unable to write ${area} storage for ${key}.`);
  }
}
async function sendRuntimeMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      const runtimeError = chrome.runtime.lastError;
      if (runtimeError) {
        reject(new Error(runtimeError.message));
        return;
      }
      resolve(response);
    });
  });
}
var init_storageAccess = __esm({
  "src/shared/storageAccess.ts"() {
    "use strict";
  }
});

// src/infrastructure/storage/ChromeRunStatusRepository.ts
var ChromeRunStatusRepository;
var init_ChromeRunStatusRepository = __esm({
  "src/infrastructure/storage/ChromeRunStatusRepository.ts"() {
    "use strict";
    init_constants();
    init_storageAccess();
    ChromeRunStatusRepository = class {
      async get() {
        const storedValue = await getStorageValue("local", STATUS_STORAGE_KEY, void 0);
        return { ...DEFAULT_STATUS, ...storedValue ?? {} };
      }
      async save(status) {
        await setStorageValue("local", STATUS_STORAGE_KEY, status);
      }
    };
  }
});

// src/shared/bridgeUrlResolver.ts
function normalizeWebSocketUrl(value, fallback = DEFAULT_WEBSOCKET_URL) {
  return toWebSocketUrl(value, fallback);
}
function normalizeOptionalWebSocketUrl(value) {
  return toWebSocketUrl(value, "");
}
function normalizeResolverUrl(value) {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const parsedUrl = new URL(withProtocol);
    const hostname = parsedUrl.hostname.toLowerCase();
    if (hostname === "pastebin.com" || hostname.endsWith(".pastebin.com")) {
      const pasteId = extractPastebinId(parsedUrl.pathname);
      if (pasteId) {
        return `https://pastebin.com/raw/${pasteId}`;
      }
    }
    if (parsedUrl.protocol !== "https:" && parsedUrl.protocol !== "http:") {
      return "";
    }
    return parsedUrl.toString();
  } catch {
    return "";
  }
}
function extractPastebinId(pathname) {
  const pathSegments = pathname.split("/").filter(Boolean);
  if (pathSegments.length === 0) {
    return null;
  }
  if (pathSegments[0] === "raw") {
    return pathSegments[1] ?? null;
  }
  return pathSegments[0] ?? null;
}
function toWebSocketUrl(value, fallback) {
  const trimmed = value.trim();
  if (!trimmed) {
    return fallback;
  }
  let normalized = trimmed;
  if (/^tcp:\/\//i.test(normalized)) {
    normalized = normalized.replace(/^tcp:/i, "ws:");
  } else if (/^https:\/\//i.test(normalized)) {
    normalized = normalized.replace(/^https:/i, "wss:");
  } else if (/^http:\/\//i.test(normalized)) {
    normalized = normalized.replace(/^http:/i, "ws:");
  } else if (!/^(?:wss?|https?|tcp):\/\//i.test(normalized)) {
    normalized = `ws://${normalized}`;
  }
  try {
    const parsedUrl = new URL(normalized);
    if (parsedUrl.protocol !== "ws:" && parsedUrl.protocol !== "wss:") {
      return fallback;
    }
    return parsedUrl.toString().replace(/\/$/, "");
  } catch {
    return fallback;
  }
}
var init_bridgeUrlResolver = __esm({
  "src/shared/bridgeUrlResolver.ts"() {
    "use strict";
    init_constants();
  }
});

// src/infrastructure/storage/ChromeSettingsRepository.ts
function normalizeConnectionMode(value) {
  return typeof value === "string" && VALID_CONNECTION_MODES.has(value) ? value : DEFAULT_SETTINGS.connectionMode;
}
function normalizeRelayUrl(value) {
  if (typeof value !== "string") return "";
  return normalizeOptionalWebSocketUrl(value);
}
function normalizeSessionId(value) {
  if (typeof value !== "string") return DEFAULT_SETTINGS.sessionId;
  const trimmed = value.trim();
  return trimmed || DEFAULT_SETTINGS.sessionId;
}
var VALID_CONNECTION_MODES, ChromeSettingsRepository;
var init_ChromeSettingsRepository = __esm({
  "src/infrastructure/storage/ChromeSettingsRepository.ts"() {
    "use strict";
    init_bridgeUrlResolver();
    init_constants();
    init_storageAccess();
    VALID_CONNECTION_MODES = /* @__PURE__ */ new Set(["auto", "relay", "tunnel"]);
    ChromeSettingsRepository = class {
      async get() {
        const storedValue = await getStorageValue("sync", SETTINGS_STORAGE_KEY, void 0);
        return this.normalize({ ...DEFAULT_SETTINGS, ...storedValue ?? {} });
      }
      async save(patch) {
        const nextValue = this.normalize({ ...await this.get(), ...patch });
        await setStorageValue("sync", SETTINGS_STORAGE_KEY, nextValue);
        return nextValue;
      }
      normalize(settings) {
        return {
          enabled: Boolean(settings.enabled),
          websocketUrl: normalizeWebSocketUrl(settings.websocketUrl),
          websocketResolverUrl: normalizeResolverUrl(DEFAULT_WEBSOCKET_RESOLVER_URL),
          fileNamePrefix: settings.fileNamePrefix.trim() || DEFAULT_SETTINGS.fileNamePrefix,
          requestTimeoutMs: Math.max(1e3, Math.round(settings.requestTimeoutMs || DEFAULT_SETTINGS.requestTimeoutMs)),
          connectionMode: normalizeConnectionMode(settings.connectionMode),
          relayUrl: normalizeRelayUrl(settings.relayUrl),
          sessionId: normalizeSessionId(settings.sessionId)
        };
      }
    };
  }
});

// src/options/index.ts
var require_options = __commonJS({
  "src/options/index.ts"() {
    init_ChromeRunStatusRepository();
    init_ChromeSettingsRepository();
    init_constants();
    var settingsRepository = new ChromeSettingsRepository();
    var runStatusRepository = new ChromeRunStatusRepository();
    var form = document.querySelector("#settings-form");
    var enabledInput = document.querySelector("#enabled");
    var websocketUrlInput = document.querySelector("#websocket-url");
    var websocketResolverUrlInput = document.querySelector("#websocket-resolver-url");
    var fileNamePrefixInput = document.querySelector("#file-name-prefix");
    var requestTimeoutInput = document.querySelector("#request-timeout-ms");
    var connectionModeInput = document.querySelector("#connection-mode");
    var relayUrlInput = document.querySelector("#relay-url");
    var sessionIdInput = document.querySelector("#session-id");
    var reconnectButton = document.querySelector("#reconnect-button");
    var applyReconnectButton = document.querySelector("#apply-reconnect-button");
    var statusState = document.querySelector("#status-state");
    var statusMessage = document.querySelector("#status-message");
    var statusUpdatedAt = document.querySelector("#status-updated-at");
    var statusFileName = document.querySelector("#status-file-name");
    var statusTarget = document.querySelector("#status-target");
    async function initialize() {
      const [settings, status] = await Promise.all([settingsRepository.get(), runStatusRepository.get()]);
      renderSettings(settings);
      renderStatus(status);
    }
    function renderSettings(settings) {
      if (!form || !enabledInput || !websocketUrlInput || !websocketResolverUrlInput || !fileNamePrefixInput || !requestTimeoutInput) {
        return;
      }
      enabledInput.checked = settings.enabled;
      websocketUrlInput.value = settings.websocketUrl;
      websocketResolverUrlInput.value = DEFAULT_WEBSOCKET_RESOLVER_URL;
      fileNamePrefixInput.value = settings.fileNamePrefix;
      requestTimeoutInput.value = String(settings.requestTimeoutMs);
      if (connectionModeInput) connectionModeInput.value = settings.connectionMode;
      if (relayUrlInput) relayUrlInput.value = settings.relayUrl;
      if (sessionIdInput) sessionIdInput.value = settings.sessionId;
    }
    function renderStatus(status) {
      if (!statusState || !statusMessage || !statusUpdatedAt || !statusFileName || !statusTarget) {
        return;
      }
      statusState.dataset.state = status.state;
      statusState.textContent = status.state;
      statusMessage.textContent = status.message;
      statusUpdatedAt.textContent = status.updatedAt ? new Date(status.updatedAt).toLocaleString() : "Never";
      statusFileName.textContent = status.lastFileName ?? "Not available";
      statusTarget.textContent = status.targetUrl ?? "Not configured";
    }
    function readFormPatch() {
      if (!enabledInput || !websocketUrlInput || !fileNamePrefixInput || !requestTimeoutInput) {
        return null;
      }
      return {
        enabled: enabledInput.checked,
        websocketUrl: websocketUrlInput.value,
        websocketResolverUrl: DEFAULT_WEBSOCKET_RESOLVER_URL,
        fileNamePrefix: fileNamePrefixInput.value,
        requestTimeoutMs: Number(requestTimeoutInput.value),
        connectionMode: connectionModeInput?.value ?? "auto",
        relayUrl: relayUrlInput?.value ?? "",
        sessionId: sessionIdInput?.value ?? ""
      };
    }
    async function applyAndReconnect(event) {
      event?.preventDefault();
      const patch = readFormPatch();
      if (!patch || !applyReconnectButton) return;
      applyReconnectButton.disabled = true;
      try {
        const settings = await settingsRepository.save(patch);
        renderSettings(settings);
        await chrome.runtime.sendMessage({ type: "reconnect-bridge" });
        renderStatus(await runStatusRepository.get());
      } finally {
        applyReconnectButton.disabled = false;
      }
    }
    async function reconnectBridge() {
      if (!reconnectButton) {
        return;
      }
      reconnectButton.disabled = true;
      try {
        await chrome.runtime.sendMessage({ type: "reconnect-bridge" });
        renderStatus(await runStatusRepository.get());
      } finally {
        reconnectButton.disabled = false;
      }
    }
    form?.addEventListener("submit", (event) => {
      void applyAndReconnect(event);
    });
    reconnectButton?.addEventListener("click", () => {
      void reconnectBridge();
    });
    applyReconnectButton?.addEventListener("click", (event) => {
      if (event.target.type !== "submit") {
        void applyAndReconnect();
      }
    });
    chrome.storage?.onChanged?.addListener((changes, areaName) => {
      if (areaName === "local" && changes["pageSignalCapture.status"]) {
        void runStatusRepository.get().then(renderStatus);
      }
    });
    void initialize();
  }
});
export default require_options();
//# sourceMappingURL=options.js.map
