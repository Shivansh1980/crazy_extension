var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res) => function __init() {
  return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
};
var __commonJS = (cb, mod) => function __require() {
  return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
};

// src/shared/constants.ts
var SETTINGS_STORAGE_KEY, STATUS_STORAGE_KEY, DEFAULT_WEBSOCKET_URL, DEFAULT_WEBSOCKET_RESOLVER_URL, BRIDGE_CLIENT_NAME, BRIDGE_RECONNECT_INTERVAL_MS, BRIDGE_RESOLVER_TIMEOUT_MS, DEFAULT_SETTINGS, DEFAULT_STATUS;
var init_constants = __esm({
  "src/shared/constants.ts"() {
    "use strict";
    SETTINGS_STORAGE_KEY = "pageSignalCapture.settings";
    STATUS_STORAGE_KEY = "pageSignalCapture.status";
    DEFAULT_WEBSOCKET_URL = "ws://127.0.0.1:8765";
    DEFAULT_WEBSOCKET_RESOLVER_URL = "https://pastebin.com/raw/pmrhGPW5";
    BRIDGE_CLIENT_NAME = "page-signal-capture";
    BRIDGE_RECONNECT_INTERVAL_MS = 5e3;
    BRIDGE_RESOLVER_TIMEOUT_MS = 5e3;
    DEFAULT_SETTINGS = {
      enabled: true,
      websocketUrl: DEFAULT_WEBSOCKET_URL,
      websocketResolverUrl: DEFAULT_WEBSOCKET_RESOLVER_URL,
      fileNamePrefix: "ui-capture",
      requestTimeoutMs: 15e3
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
async function resolveBridgeEndpoint(websocketUrl, _websocketResolverUrl) {
  const normalizedDirectUrl = normalizeWebSocketUrl(websocketUrl);
  const normalizedResolverUrl = normalizeResolverUrl(DEFAULT_WEBSOCKET_RESOLVER_URL);
  if (!normalizedResolverUrl) {
    return {
      targetUrl: normalizedDirectUrl,
      source: "direct",
      resolverUrl: null
    };
  }
  const abortController = new AbortController();
  const timeoutHandle = window.setTimeout(() => abortController.abort(), BRIDGE_RESOLVER_TIMEOUT_MS);
  let response;
  try {
    response = await fetch(normalizedResolverUrl, {
      method: "GET",
      cache: "no-store",
      signal: abortController.signal,
      headers: {
        Accept: "application/json, text/plain;q=0.9, */*;q=0.8"
      }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown resolver fetch error.";
    throw new Error(`Resolver request failed: ${message}`);
  } finally {
    window.clearTimeout(timeoutHandle);
  }
  if (!response.ok) {
    throw new Error(`Resolver endpoint returned ${response.status} ${response.statusText}.`);
  }
  const body = (await response.text()).trim();
  const resolvedUrl = extractWebSocketUrlFromResolverPayload(body);
  if (!resolvedUrl) {
    throw new Error("Resolver response did not contain a valid ws:// or wss:// bridge URL.");
  }
  return {
    targetUrl: toWebSocketUrl(resolvedUrl, normalizedDirectUrl),
    source: "resolver",
    resolverUrl: normalizedResolverUrl
  };
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
function extractWebSocketUrlFromResolverPayload(payload) {
  const jsonMatch = tryExtractFromJson(payload);
  if (jsonMatch) {
    return jsonMatch;
  }
  const regexMatch = payload.match(/(?:wss?|https?|tcp):\/\/[^\s"']+/i);
  return regexMatch?.[0] ?? null;
}
function tryExtractFromJson(payload) {
  try {
    const parsed = JSON.parse(payload);
    const candidateKeys = ["websocketUrl", "webSocketUrl", "bridgeUrl", "url", "targetUrl"];
    for (const key of candidateKeys) {
      const value = parsed[key];
      if (typeof value === "string" && /^(?:wss?|https?|tcp):\/\//i.test(value.trim())) {
        return value.trim();
      }
    }
    return null;
  } catch {
    return null;
  }
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
var ChromeSettingsRepository;
var init_ChromeSettingsRepository = __esm({
  "src/infrastructure/storage/ChromeSettingsRepository.ts"() {
    "use strict";
    init_bridgeUrlResolver();
    init_constants();
    init_storageAccess();
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
          requestTimeoutMs: Math.max(1e3, Math.round(settings.requestTimeoutMs || DEFAULT_SETTINGS.requestTimeoutMs))
        };
      }
    };
  }
});

// src/shared/debug.ts
function normalizeDetails(details) {
  if (details instanceof Error) {
    return {
      name: details.name,
      message: details.message,
      stack: details.stack
    };
  }
  if (typeof details === "object" && details !== null) {
    return JSON.parse(JSON.stringify(details, (_key, value) => {
      if (value instanceof Error) {
        return {
          name: value.name,
          message: value.message,
          stack: value.stack
        };
      }
      return value;
    }));
  }
  return details;
}
function debugLog(scope, message, details) {
  if (!DEBUG_LOGGING_ENABLED) {
    return;
  }
  if (details === void 0) {
    console.log(`[${scope}] ${message}`);
    return;
  }
  console.log(`[${scope}] ${message}`, normalizeDetails(details));
}
function debugWarn(scope, message, details) {
  if (!DEBUG_LOGGING_ENABLED) {
    return;
  }
  if (details === void 0) {
    console.warn(`[${scope}] ${message}`);
    return;
  }
  console.warn(`[${scope}] ${message}`, normalizeDetails(details));
}
function debugError(scope, message, details) {
  if (!DEBUG_LOGGING_ENABLED) {
    return;
  }
  if (details === void 0) {
    console.error(`[${scope}] ${message}`);
    return;
  }
  console.error(`[${scope}] ${message}`, normalizeDetails(details));
}
var DEBUG_LOGGING_ENABLED;
var init_debug = __esm({
  "src/shared/debug.ts"() {
    "use strict";
    DEBUG_LOGGING_ENABLED = true;
  }
});

// src/offscreen/index.ts
var require_offscreen = __commonJS({
  "src/offscreen/index.ts"() {
    init_ChromeRunStatusRepository();
    init_ChromeSettingsRepository();
    init_debug();
    init_bridgeUrlResolver();
    init_constants();
    var ExtensionBridgeClient = class {
      settingsRepository = new ChromeSettingsRepository();
      runStatusRepository = new ChromeRunStatusRepository();
      clientId = crypto.randomUUID();
      socket = null;
      reconnectTimer = null;
      currentSettings = null;
      connectionGeneration = 0;
      resolvedTargetUrl = null;
      resolvedEndpoint = null;
      consecutiveConnectionFailures = 0;
      startPromise = null;
      hasConnectedOnce = false;
      pendingBridgeMessages = [];
      lastPublishedPopupStatusKey = null;
      constructor() {
        debugLog("offscreen", "Bridge client constructed.");
        this.registerRuntimeListeners();
      }
      async start(forceReconnect = false) {
        debugLog("offscreen", "Bridge start requested.", { forceReconnect });
        if (this.startPromise) {
          await this.startPromise;
          if (!forceReconnect) {
            return;
          }
        }
        this.startPromise = this.runStart(forceReconnect);
        try {
          await this.startPromise;
        } finally {
          this.startPromise = null;
        }
      }
      async runStart(forceReconnect) {
        const settings = await this.settingsRepository.get();
        debugLog("offscreen", "Loaded bridge settings.", settings);
        const settingsChanged = this.currentSettings === null || this.currentSettings.websocketUrl !== settings.websocketUrl || this.currentSettings.websocketResolverUrl !== settings.websocketResolverUrl || this.currentSettings.enabled !== settings.enabled;
        const shouldReplaceExistingSocket = forceReconnect || settingsChanged;
        this.currentSettings = settings;
        if (settingsChanged) {
          this.invalidateResolvedEndpoint();
        }
        if (!settings.enabled) {
          debugWarn("offscreen", "Bridge is disabled in settings.");
          await this.closeConnection("Desktop bridge is disabled in extension settings.");
          return;
        }
        if (shouldReplaceExistingSocket) {
          this.disposeActiveSocket();
        }
        if (!forceReconnect && this.socket && this.socket.readyState !== WebSocket.CLOSED) {
          return;
        }
        await this.connect(settings, settingsChanged);
      }
      async connect(settings, settingsChanged) {
        this.clearReconnectTimer();
        const generation = ++this.connectionGeneration;
        const endpoint = await this.resolveEndpoint(settings, settingsChanged);
        this.resolvedTargetUrl = endpoint.targetUrl;
        this.resolvedEndpoint = endpoint;
        debugLog("offscreen", "Connecting websocket.", endpoint);
        await this.updateStatus({
          state: "connecting",
          updatedAt: (/* @__PURE__ */ new Date()).toISOString(),
          message: endpoint.source === "resolver" ? `Connecting to ${endpoint.targetUrl} from resolver ${endpoint.resolverUrl}...` : `Connecting to ${endpoint.targetUrl}...`,
          lastFileName: null,
          targetUrl: endpoint.targetUrl
        });
        const socket = new WebSocket(endpoint.targetUrl);
        this.socket = socket;
        socket.addEventListener("open", () => {
          if (generation !== this.connectionGeneration) {
            socket.close();
            return;
          }
          this.consecutiveConnectionFailures = 0;
          this.hasConnectedOnce = true;
          debugLog("offscreen", "running...");
          debugLog("offscreen", "WebSocket connection opened.", endpoint.targetUrl);
          this.send({
            type: "client.register",
            clientId: this.clientId,
            name: BRIDGE_CLIENT_NAME,
            version: "1.0.0",
            capabilities: ["capture.full-page"]
          });
          this.flushPendingBridgeMessages();
          void this.publishPopupStatus();
          void this.publishPopupMessageHistory();
          void this.updateStatus({
            state: "connected",
            updatedAt: (/* @__PURE__ */ new Date()).toISOString(),
            message: endpoint.source === "resolver" ? `Connected to desktop bridge at ${endpoint.targetUrl} using resolver ${endpoint.resolverUrl}.` : `Connected to desktop bridge at ${endpoint.targetUrl}.`,
            lastFileName: null,
            targetUrl: endpoint.targetUrl
          });
        });
        socket.addEventListener("message", (event) => {
          debugLog("offscreen", "Received websocket message.");
          void this.handleMessage(event.data, endpoint.targetUrl, settings, generation);
        });
        socket.addEventListener("error", () => {
          debugLog("offscreen", "WebSocket error received; waiting for close event before retry.", {
            targetUrl: endpoint.targetUrl,
            readyState: socket.readyState
          });
          socket.close();
        });
        socket.addEventListener("close", (event) => {
          if (generation !== this.connectionGeneration) {
            return;
          }
          this.socket = null;
          this.consecutiveConnectionFailures += 1;
          const closeDetails = {
            targetUrl: endpoint.targetUrl,
            code: event.code,
            reason: event.reason || null,
            wasClean: event.wasClean,
            previouslyConnected: this.hasConnectedOnce,
            consecutiveConnectionFailures: this.consecutiveConnectionFailures
          };
          if (this.hasConnectedOnce && event.code !== 1e3) {
            debugWarn("offscreen", "WebSocket connection closed unexpectedly.", closeDetails);
          } else {
            debugLog("offscreen", "WebSocket connection closed; reconnect will be attempted.", closeDetails);
          }
          const refreshHint = this.currentSettings?.websocketResolverUrl ? " Refreshing the resolver URL on the next attempt." : "";
          void this.updateStatus({
            state: "disconnected",
            updatedAt: (/* @__PURE__ */ new Date()).toISOString(),
            message: `Bridge connection closed. Retrying ${endpoint.targetUrl} in 5 seconds. Failure count: ${this.consecutiveConnectionFailures}.${refreshHint}`,
            lastFileName: null,
            targetUrl: endpoint.targetUrl
          });
          this.scheduleReconnect();
        });
      }
      async handleMessage(rawData, targetUrl, settings, generation) {
        if (generation !== this.connectionGeneration) {
          return;
        }
        const payload = typeof rawData === "string" ? rawData : new TextDecoder().decode(rawData);
        let message;
        try {
          message = JSON.parse(payload);
        } catch {
          debugWarn("offscreen", "Ignoring non-JSON websocket payload.");
          return;
        }
        if (message.type === "clipboard.write") {
          try {
            debugLog("offscreen", "Processing clipboard write request.", {
              requestId: message.requestId,
              textLength: message.text.length
            });
            await this.writeClipboardText(message.text);
            const lineCount = message.text.length === 0 ? 0 : message.text.split(/\r\n|\r|\n/).length;
            await this.updateStatus({
              state: "success",
              updatedAt: (/* @__PURE__ */ new Date()).toISOString(),
              message: "Clipboard content updated from the desktop control center.",
              lastFileName: null,
              targetUrl
            });
            this.sendOrQueueBridgeMessage({
              type: "clipboard.result",
              requestId: message.requestId,
              characterCount: message.text.length,
              lineCount
            });
            debugLog("offscreen", "Clipboard write completed.", {
              requestId: message.requestId,
              lineCount,
              characterCount: message.text.length
            });
          } catch (error) {
            const messageText = error instanceof Error ? error.message : "Clipboard write failed.";
            debugError("offscreen", "Clipboard write failed.", { requestId: message.requestId, error: messageText });
            await this.updateStatus({
              state: "error",
              updatedAt: (/* @__PURE__ */ new Date()).toISOString(),
              message: messageText,
              lastFileName: null,
              targetUrl
            });
            this.sendOrQueueBridgeMessage({
              type: "clipboard.error",
              requestId: message.requestId,
              message: messageText
            });
          }
          return;
        }
        if (message.type === "popup.show") {
          try {
            debugLog("offscreen", "Processing popup show request.", {
              requestId: message.requestId,
              textLength: message.text.length
            });
            const popupResponse = await this.requestPagePopup(message.text);
            if (!popupResponse.ok || !popupResponse.status) {
              throw new Error(popupResponse.message || "The background worker returned an empty popup response.");
            }
            this.sendOrQueueBridgeMessage({
              type: "popup.result",
              requestId: message.requestId,
              action: popupResponse.action ?? "updated",
              status: popupResponse.status
            });
            debugLog("offscreen", "Popup request completed.", popupResponse.status);
          } catch (error) {
            const messageText = error instanceof Error ? error.message : "Popup request failed.";
            debugError("offscreen", "Popup request failed.", { requestId: message.requestId, error: messageText });
            this.sendOrQueueBridgeMessage({
              type: "popup.error",
              requestId: message.requestId,
              message: messageText
            });
          }
          return;
        }
        try {
          debugLog("offscreen", "Processing capture request.", { requestId: message.requestId, targetUrl });
          const response = await this.requestCapture(settings);
          if (!response.ok || !response.capturedPage) {
            throw new Error(response.message || "The background worker returned an empty capture response.");
          }
          await this.updateStatus({
            state: "success",
            updatedAt: (/* @__PURE__ */ new Date()).toISOString(),
            message: "Screenshot captured and returned to the desktop bridge.",
            lastFileName: response.capturedPage.fileName,
            targetUrl
          });
          this.sendOrQueueBinaryCaptureResult(message.requestId, response.capturedPage);
          debugLog("offscreen", "Capture result sent back to desktop bridge.", message.requestId);
        } catch (error) {
          const messageText = error instanceof Error ? error.message : "Capture request failed.";
          debugError("offscreen", "Capture request failed.", { requestId: message.requestId, error: messageText });
          await this.updateStatus({
            state: "error",
            updatedAt: (/* @__PURE__ */ new Date()).toISOString(),
            message: messageText,
            lastFileName: null,
            targetUrl
          });
          this.sendOrQueueBridgeMessage({
            type: "capture.error",
            requestId: message.requestId,
            message: messageText
          });
        }
      }
      async requestCapture(settings) {
        return new Promise((resolve, reject) => {
          const timeoutHandle = window.setTimeout(() => {
            debugWarn("offscreen", "Capture request timed out.", settings.requestTimeoutMs);
            reject(new Error(`Capture request timed out after ${settings.requestTimeoutMs}ms.`));
          }, settings.requestTimeoutMs);
          chrome.runtime.sendMessage({ type: "bridge-capture-request" }, (response) => {
            clearTimeout(timeoutHandle);
            const runtimeError = chrome.runtime.lastError;
            if (runtimeError) {
              debugError("offscreen", "Background capture request failed.", runtimeError.message);
              reject(new Error(runtimeError.message));
              return;
            }
            debugLog("offscreen", "Received background capture response.");
            resolve(response ?? { ok: false, message: "No response from background worker." });
          });
        });
      }
      async requestPagePopup(text) {
        return new Promise((resolve, reject) => {
          chrome.runtime.sendMessage({ type: "bridge-popup-show", text }, (response) => {
            const runtimeError = chrome.runtime.lastError;
            if (runtimeError) {
              reject(new Error(runtimeError.message));
              return;
            }
            resolve(response ?? { ok: false, message: "No response from background worker." });
          });
        });
      }
      async publishPopupStatus() {
        try {
          const response = await new Promise((resolve, reject) => {
            chrome.runtime.sendMessage({ type: "popup-status-get" }, (message) => {
              const runtimeError = chrome.runtime.lastError;
              if (runtimeError) {
                reject(new Error(runtimeError.message));
                return;
              }
              resolve(message ?? { ok: false });
            });
          });
          if (response.ok && response.status) {
            this.publishPopupStatusIfChanged(response.status);
          }
        } catch (error) {
          debugWarn("offscreen", "Unable to publish popup status.", error);
        }
      }
      publishPopupStatusIfChanged(status) {
        const statusKey = JSON.stringify({
          exists: status.exists,
          state: status.state,
          tabId: status.tabId,
          pageUrl: status.pageUrl,
          textLength: status.textLength
        });
        if (this.lastPublishedPopupStatusKey === statusKey) {
          debugLog("offscreen", "Skipping duplicate popup status publish.", status);
          return;
        }
        this.lastPublishedPopupStatusKey = statusKey;
        this.sendOrQueueBridgeMessage({ type: "popup.status", status });
      }
      async publishPopupMessageHistory() {
        try {
          const response = await new Promise((resolve, reject) => {
            chrome.runtime.sendMessage({ type: "popup-message-history-get" }, (message) => {
              const runtimeError = chrome.runtime.lastError;
              if (runtimeError) {
                reject(new Error(runtimeError.message));
                return;
              }
              resolve(message ?? { ok: false, messages: [] });
            });
          });
          if (!response.ok || !Array.isArray(response.messages)) {
            return;
          }
          for (const message of [...response.messages].reverse()) {
            this.sendOrQueueBridgeMessage({
              type: "popup.message",
              text: typeof message.text === "string" ? message.text : "",
              pageUrl: typeof message.pageUrl === "string" ? message.pageUrl : null,
              tabId: typeof message.tabId === "number" ? message.tabId : null,
              sentAt: typeof message.sentAt === "string" ? message.sentAt : (/* @__PURE__ */ new Date()).toISOString()
            });
          }
        } catch (error) {
          debugWarn("offscreen", "Unable to publish popup message history.", error);
        }
      }
      send(message) {
        if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
          debugWarn("offscreen", "Skipping websocket send because socket is not open.", message.type);
          return;
        }
        debugLog("offscreen", "Sending websocket message.", message.type);
        this.socket.send(JSON.stringify(message));
      }
      sendOrQueueBridgeMessage(message) {
        if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
          debugLog("offscreen", "Queueing bridge message until websocket is open.", message.type);
          this.pendingBridgeMessages.push(message);
          if (this.pendingBridgeMessages.length > 20) {
            this.pendingBridgeMessages.splice(0, this.pendingBridgeMessages.length - 20);
          }
          return;
        }
        this.send(message);
      }
      sendOrQueueBinaryCaptureResult(requestId, capturedPage) {
        const queuedMessage = {
          type: "capture.result.binary",
          requestId,
          capturedPage
        };
        if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
          debugLog("offscreen", "Queueing binary capture result until websocket is open.", {
            requestId,
            fileName: capturedPage.fileName
          });
          this.pendingBridgeMessages.push(queuedMessage);
          if (this.pendingBridgeMessages.length > 20) {
            this.pendingBridgeMessages.splice(0, this.pendingBridgeMessages.length - 20);
          }
          return;
        }
        this.sendBinaryCaptureResult(requestId, capturedPage);
      }
      flushPendingBridgeMessages() {
        if (!this.socket || this.socket.readyState !== WebSocket.OPEN || this.pendingBridgeMessages.length === 0) {
          return;
        }
        const queuedMessages = [...this.pendingBridgeMessages];
        this.pendingBridgeMessages = [];
        for (const message of queuedMessages) {
          if (message.type === "capture.result.binary") {
            this.sendBinaryCaptureResult(message.requestId, message.capturedPage);
            continue;
          }
          this.send(message);
        }
      }
      sendBinaryCaptureResult(requestId, capturedPage) {
        if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
          debugWarn("offscreen", "Skipping binary capture send because socket is not open.", requestId);
          return;
        }
        const imageBytes = this.base64ToBytes(capturedPage.base64Data);
        const metadataBytes = new TextEncoder().encode(
          JSON.stringify({
            type: "capture.result.binary",
            requestId,
            capturedPage: {
              tab: capturedPage.tab,
              mimeType: capturedPage.mimeType,
              fileName: capturedPage.fileName,
              capturedAt: capturedPage.capturedAt,
              widthCssPx: capturedPage.widthCssPx,
              heightCssPx: capturedPage.heightCssPx,
              scale: capturedPage.scale
            }
          })
        );
        const envelope = new Uint8Array(4 + metadataBytes.length + imageBytes.length);
        const view = new DataView(envelope.buffer);
        view.setUint32(0, metadataBytes.length);
        envelope.set(metadataBytes, 4);
        envelope.set(imageBytes, 4 + metadataBytes.length);
        debugLog("offscreen", "Sending binary capture result.", {
          requestId,
          fileName: capturedPage.fileName,
          bytes: imageBytes.length,
          metadataBytes: metadataBytes.length
        });
        this.socket.send(envelope.buffer);
      }
      base64ToBytes(base64Data) {
        const normalizedBase64 = base64Data.replace(/\s+/g, "");
        const binaryString = atob(normalizedBase64);
        const bytes = new Uint8Array(binaryString.length);
        for (let index = 0; index < binaryString.length; index += 1) {
          bytes[index] = binaryString.charCodeAt(index);
        }
        return bytes;
      }
      async writeClipboardText(text) {
        if (typeof text !== "string") {
          throw new Error("Clipboard payload must be a string.");
        }
        if (typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
          try {
            await navigator.clipboard.write([
              new ClipboardItem({
                "text/plain": new Blob([text], { type: "text/plain" })
              })
            ]);
            return;
          } catch (error) {
            debugWarn("offscreen", "ClipboardItem write failed; falling back to writeText.", error);
          }
        }
        if (navigator.clipboard?.writeText) {
          try {
            await navigator.clipboard.writeText(text);
            return;
          } catch (error) {
            debugWarn("offscreen", "navigator.clipboard.writeText failed; falling back to execCommand.", error);
          }
        }
        if (this.copyWithTextarea(text)) {
          return;
        }
        if (this.copyWithContentEditable(text)) {
          return;
        }
        throw new Error("All clipboard write strategies failed in the offscreen document.");
      }
      copyWithTextarea(text) {
        const container = document.body ?? document.documentElement;
        if (!container) {
          return false;
        }
        const activeElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        const textarea = document.createElement("textarea");
        textarea.value = text;
        textarea.setAttribute("readonly", "true");
        textarea.setAttribute("aria-hidden", "true");
        textarea.style.position = "fixed";
        textarea.style.top = "0";
        textarea.style.left = "0";
        textarea.style.width = "1px";
        textarea.style.height = "1px";
        textarea.style.opacity = "0";
        textarea.style.pointerEvents = "none";
        textarea.style.zIndex = "-1";
        container.appendChild(textarea);
        try {
          textarea.focus();
          textarea.select();
          textarea.setSelectionRange(0, textarea.value.length);
          return document.execCommand("copy");
        } catch {
          return false;
        } finally {
          textarea.remove();
          activeElement?.focus({ preventScroll: true });
        }
      }
      copyWithContentEditable(text) {
        const container = document.body ?? document.documentElement;
        if (!container) {
          return false;
        }
        const selection = window.getSelection();
        const existingRanges = selection ? Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index).cloneRange()) : [];
        const activeElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        const editable = document.createElement("div");
        editable.contentEditable = "true";
        editable.setAttribute("aria-hidden", "true");
        editable.style.position = "fixed";
        editable.style.top = "0";
        editable.style.left = "0";
        editable.style.opacity = "0";
        editable.style.pointerEvents = "none";
        editable.style.whiteSpace = "pre-wrap";
        editable.textContent = text;
        container.appendChild(editable);
        try {
          const range = document.createRange();
          range.selectNodeContents(editable);
          selection?.removeAllRanges();
          selection?.addRange(range);
          editable.focus();
          return document.execCommand("copy");
        } catch {
          return false;
        } finally {
          selection?.removeAllRanges();
          for (const range of existingRanges) {
            selection?.addRange(range);
          }
          editable.remove();
          activeElement?.focus({ preventScroll: true });
        }
      }
      scheduleReconnect() {
        if (this.reconnectTimer !== null) {
          return;
        }
        debugLog("offscreen", "Scheduling reconnect.", BRIDGE_RECONNECT_INTERVAL_MS);
        this.reconnectTimer = window.setTimeout(() => {
          this.reconnectTimer = null;
          void this.start(true);
        }, BRIDGE_RECONNECT_INTERVAL_MS);
      }
      clearReconnectTimer() {
        if (this.reconnectTimer !== null) {
          window.clearTimeout(this.reconnectTimer);
          this.reconnectTimer = null;
        }
      }
      async closeConnection(message) {
        debugLog("offscreen", "Closing bridge connection.", message);
        this.clearReconnectTimer();
        this.disposeActiveSocket();
        await this.updateStatus({
          state: "disconnected",
          updatedAt: (/* @__PURE__ */ new Date()).toISOString(),
          message,
          lastFileName: null,
          targetUrl: this.resolvedTargetUrl ?? this.currentSettings?.websocketUrl ?? null
        });
      }
      async resolveEndpoint(settings, settingsChanged) {
        const shouldRefreshResolver = settingsChanged || this.resolvedEndpoint === null || Boolean(settings.websocketResolverUrl);
        if (!shouldRefreshResolver && this.resolvedEndpoint) {
          return this.resolvedEndpoint;
        }
        try {
          const endpoint = await resolveBridgeEndpoint(settings.websocketUrl, settings.websocketResolverUrl);
          debugLog("offscreen", "Resolved bridge endpoint.", endpoint);
          if (this.resolvedEndpoint && this.resolvedEndpoint.targetUrl !== endpoint.targetUrl) {
            await this.updateStatus({
              state: "connecting",
              updatedAt: (/* @__PURE__ */ new Date()).toISOString(),
              message: `Resolver updated bridge target from ${this.resolvedEndpoint.targetUrl} to ${endpoint.targetUrl}.`,
              lastFileName: null,
              targetUrl: endpoint.targetUrl
            });
          }
          return endpoint;
        } catch (error) {
          const messageText = error instanceof Error ? error.message : "Unknown resolver failure.";
          debugWarn("offscreen", "Resolver failed; using fallback endpoint.", messageText);
          const fallbackEndpoint = this.resolvedEndpoint ?? {
            targetUrl: settings.websocketUrl,
            source: "direct",
            resolverUrl: null
          };
          await this.updateStatus({
            state: "disconnected",
            updatedAt: (/* @__PURE__ */ new Date()).toISOString(),
            message: `Resolver failed: ${messageText}. Continuing with ${fallbackEndpoint.targetUrl}.`,
            lastFileName: null,
            targetUrl: fallbackEndpoint.targetUrl
          });
          return fallbackEndpoint;
        }
      }
      invalidateResolvedEndpoint() {
        debugLog("offscreen", "Invalidating resolved endpoint cache.");
        this.resolvedEndpoint = null;
        this.resolvedTargetUrl = null;
        this.consecutiveConnectionFailures = 0;
      }
      disposeActiveSocket() {
        if (!this.socket) {
          return;
        }
        debugLog("offscreen", "Disposing active websocket socket.");
        this.connectionGeneration += 1;
        this.socket.close();
        this.socket = null;
      }
      async updateStatus(status) {
        try {
          await this.runStatusRepository.save(status);
        } catch (error) {
          debugWarn("offscreen", "Failed to persist offscreen bridge status.", error);
        }
      }
      registerRuntimeListeners() {
        chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
          debugLog("offscreen", "Received runtime message.", message?.type ?? "unknown");
          if (message?.type === "bridge-start") {
            void this.start(false).then(() => sendResponse({ ok: true })).catch((error) => {
              const messageText = error instanceof Error ? error.message : "Bridge startup failed.";
              debugError("offscreen", "Bridge start request failed.", messageText);
              sendResponse({ ok: false, message: messageText });
            });
            return true;
          }
          if (message?.type === "bridge-reconnect") {
            void this.start(true).then(() => sendResponse({ ok: true })).catch((error) => {
              const messageText = error instanceof Error ? error.message : "Bridge reconnect failed.";
              debugError("offscreen", "Bridge reconnect request failed.", messageText);
              sendResponse({ ok: false, message: messageText });
            });
            return true;
          }
          if (message?.type === "popup-status-changed") {
            debugLog("offscreen", "Received popup status update from background.", message.status);
            if (message.status) {
              this.publishPopupStatusIfChanged(message.status);
            }
            sendResponse({ ok: true });
            return true;
          }
          if (message?.type === "popup-page-message") {
            const payload = {
              text: typeof message.payload?.text === "string" ? message.payload.text : "",
              pageUrl: typeof message.payload?.pageUrl === "string" ? message.payload.pageUrl : null,
              tabId: typeof message.payload?.tabId === "number" ? message.payload.tabId : null,
              sentAt: typeof message.payload?.sentAt === "string" ? message.payload.sentAt : (/* @__PURE__ */ new Date()).toISOString()
            };
            debugLog("offscreen", "Forwarding popup text message to desktop bridge.", {
              tabId: payload.tabId,
              pageUrl: payload.pageUrl,
              characters: payload.text.length
            });
            this.sendOrQueueBridgeMessage({ type: "popup.message", ...payload });
            sendResponse({ ok: true });
            return true;
          }
          return false;
        });
        const storageOnChanged = chrome.storage?.onChanged;
        if (storageOnChanged?.addListener) {
          storageOnChanged.addListener((changes, areaName) => {
            if (areaName === "sync" && changes[SETTINGS_STORAGE_KEY]) {
              debugLog("offscreen", "Observed storage change for settings; restarting bridge.");
              void this.start(true).catch((error) => {
                debugWarn("offscreen", "Bridge restart after settings change failed.", error);
              });
            }
          });
        }
      }
    };
    var bridgeClient = new ExtensionBridgeClient();
    void bridgeClient.start(false).catch((error) => {
      debugError("offscreen", "Initial offscreen bridge startup failed.", error);
    });
  }
});
export default require_offscreen();
//# sourceMappingURL=offscreen.js.map
