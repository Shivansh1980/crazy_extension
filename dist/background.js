var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res, err) => function __init() {
  if (err) throw err[0];
  try {
    return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
  } catch (e) {
    throw err = [e], e;
  }
};
var __commonJS = (cb, mod) => function __require() {
  try {
    return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
  } catch (e) {
    throw mod = 0, e;
  }
};

// src/shared/errors.ts
var ExtensionError;
var init_errors = __esm({
  "src/shared/errors.ts"() {
    "use strict";
    ExtensionError = class extends Error {
      constructor(message) {
        super(message);
        this.name = "ExtensionError";
      }
    };
  }
});

// src/application/services/CaptureCycleService.ts
var CaptureCycleService;
var init_CaptureCycleService = __esm({
  "src/application/services/CaptureCycleService.ts"() {
    "use strict";
    init_errors();
    CaptureCycleService = class {
      constructor(settingsRepository, activeTabGateway, fullPageCaptureGateway, runStatusRepository) {
        this.settingsRepository = settingsRepository;
        this.activeTabGateway = activeTabGateway;
        this.fullPageCaptureGateway = fullPageCaptureGateway;
        this.runStatusRepository = runStatusRepository;
      }
      settingsRepository;
      activeTabGateway;
      fullPageCaptureGateway;
      runStatusRepository;
      async execute() {
        const settings = await this.settingsRepository.get();
        if (!settings.enabled) {
          const error = new ExtensionError("The extension bridge is disabled in options.");
          await this.saveStatus({
            state: "skipped",
            updatedAt: (/* @__PURE__ */ new Date()).toISOString(),
            message: error.message,
            lastFileName: null,
            targetUrl: settings.websocketUrl
          });
          throw error;
        }
        const tab = await this.activeTabGateway.getActiveCapturableTab();
        if (!tab) {
          const error = new ExtensionError("No capturable active tab is available. Bring the target page into focus and try again.");
          await this.saveStatus({
            state: "skipped",
            updatedAt: (/* @__PURE__ */ new Date()).toISOString(),
            message: error.message,
            lastFileName: null,
            targetUrl: settings.websocketUrl
          });
          throw error;
        }
        try {
          const capturedPage = await this.fullPageCaptureGateway.capture(tab, settings);
          await this.saveStatus({
            state: "success",
            updatedAt: (/* @__PURE__ */ new Date()).toISOString(),
            message: "Screenshot captured successfully for the desktop bridge.",
            lastFileName: capturedPage.fileName,
            targetUrl: settings.websocketUrl
          });
          return capturedPage;
        } catch (error) {
          const message = error instanceof Error ? error.message : "Unknown capture error.";
          await this.saveStatus({
            state: "error",
            updatedAt: (/* @__PURE__ */ new Date()).toISOString(),
            message,
            lastFileName: null,
            targetUrl: settings.websocketUrl
          });
          throw error;
        }
      }
      async saveStatus(status) {
        await this.runStatusRepository.save(status);
      }
    };
  }
});

// src/application/services/BridgeLifecycleService.ts
var BridgeLifecycleService;
var init_BridgeLifecycleService = __esm({
  "src/application/services/BridgeLifecycleService.ts"() {
    "use strict";
    BridgeLifecycleService = class {
      constructor(settingsRepository, bridgeRuntime) {
        this.settingsRepository = settingsRepository;
        this.bridgeRuntime = bridgeRuntime;
      }
      settingsRepository;
      bridgeRuntime;
      async ensureOnline() {
        const settings = await this.settingsRepository.get();
        if (!settings.enabled) {
          return;
        }
        await this.bridgeRuntime.ensureStarted();
        await this.bridgeRuntime.ensureConnected();
      }
      async forceReconnect() {
        const settings = await this.settingsRepository.get();
        if (!settings.enabled) {
          return;
        }
        await this.bridgeRuntime.ensureStarted();
        await this.bridgeRuntime.reconnect();
      }
    };
  }
});

// src/shared/constants.ts
var SETTINGS_STORAGE_KEY, STATUS_STORAGE_KEY, MAX_CAPTURE_DIMENSION, MAX_CAPTURE_AREA, DEFAULT_WEBSOCKET_URL, DEFAULT_WEBSOCKET_RESOLVER_URL, DEFAULT_RELAY_URL, DEFAULT_SESSION_ID, OFFSCREEN_DOCUMENT_PATH, DEFAULT_SETTINGS, DEFAULT_STATUS, BLOCKED_PROTOCOL_PREFIXES;
var init_constants = __esm({
  "src/shared/constants.ts"() {
    "use strict";
    SETTINGS_STORAGE_KEY = "pageSignalCapture.settings";
    STATUS_STORAGE_KEY = "pageSignalCapture.status";
    MAX_CAPTURE_DIMENSION = 16384;
    MAX_CAPTURE_AREA = 12e7;
    DEFAULT_WEBSOCKET_URL = "ws://127.0.0.1:8765";
    DEFAULT_WEBSOCKET_RESOLVER_URL = "https://pastebin.com/raw/pmrhGPW5";
    DEFAULT_RELAY_URL = "";
    DEFAULT_SESSION_ID = "default";
    OFFSCREEN_DOCUMENT_PATH = "offscreen.html";
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
    BLOCKED_PROTOCOL_PREFIXES = ["chrome://", "chrome-extension://", "edge://", "about:", "view-source:"];
  }
});

// src/shared/browserCapabilities.ts
function getBrowserCapabilities() {
  const chromeApi = globalThis.chrome;
  return {
    runtimeMessaging: Boolean(chromeApi?.runtime?.sendMessage),
    offscreenDocument: Boolean(chromeApi?.offscreen?.createDocument),
    debuggerApi: Boolean(chromeApi?.debugger?.attach && chromeApi?.debugger?.sendCommand),
    scriptingApi: Boolean(chromeApi?.scripting?.executeScript),
    tabsApi: Boolean(chromeApi?.tabs?.query),
    commandsApi: Boolean(chromeApi?.commands?.onCommand),
    downloadsApi: Boolean(chromeApi?.downloads?.download),
    clipboardWrite: Boolean(
      typeof ClipboardItem !== "undefined" && navigator.clipboard?.write || navigator.clipboard?.writeText
    )
  };
}
function getBrowserIdentity() {
  const userAgent = navigator.userAgent;
  if (/Brave\//i.test(userAgent)) {
    return { name: "Brave", engine: "chromium" };
  }
  if (/Edg\//i.test(userAgent)) {
    return { name: "Microsoft Edge", engine: "chromium" };
  }
  if (/Chrome\//i.test(userAgent)) {
    return { name: "Google Chrome", engine: "chromium" };
  }
  return {
    name: "This browser",
    engine: "unknown"
  };
}
function getUnsupportedCapabilitiesSummary() {
  const capabilities = getBrowserCapabilities();
  const unsupported = [];
  if (!capabilities.runtimeMessaging) {
    unsupported.push("runtime messaging");
  }
  if (!capabilities.offscreenDocument) {
    unsupported.push("offscreen documents");
  }
  if (!capabilities.debuggerApi) {
    unsupported.push("debugger API");
  }
  if (!capabilities.scriptingApi) {
    unsupported.push("scripting API");
  }
  if (!capabilities.tabsApi) {
    unsupported.push("tabs API");
  }
  return unsupported;
}
var init_browserCapabilities = __esm({
  "src/shared/browserCapabilities.ts"() {
    "use strict";
  }
});

// src/infrastructure/browser/ChromeActiveTabGateway.ts
var ChromeActiveTabGateway;
var init_ChromeActiveTabGateway = __esm({
  "src/infrastructure/browser/ChromeActiveTabGateway.ts"() {
    "use strict";
    init_browserCapabilities();
    init_constants();
    init_errors();
    ChromeActiveTabGateway = class {
      async getActiveCapturableTab() {
        const capabilities = getBrowserCapabilities();
        if (!capabilities.tabsApi) {
          throw new ExtensionError("This browser does not support the tabs API required to inspect the active page.");
        }
        const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        if (!tab?.id || !tab.url || this.isBlockedUrl(tab.url)) {
          return null;
        }
        return {
          id: tab.id,
          title: tab.title ?? "Untitled page",
          url: tab.url
        };
      }
      isBlockedUrl(url) {
        return BLOCKED_PROTOCOL_PREFIXES.some((prefix) => url.startsWith(prefix));
      }
    };
  }
});

// src/infrastructure/browser/ChromeClipboardAccessGateway.ts
function enableClipboardAccessInPage() {
  const stateKey = "__pageSignalClipboardAccessState";
  const styleElementId = "page-signal-clipboard-access-style";
  const popupHostId = "page-signal-capture-popup-host";
  const legacyProtectedHandlerProps = [
    "oncopy",
    "oncut",
    "onpaste",
    "onbeforecopy",
    "onbeforecut",
    "onbeforepaste",
    "onselectstart",
    "oncontextmenu",
    "ondragstart"
  ];
  const win = window;
  const existingState = win[stateKey];
  const legacyStateDetected = Boolean(
    existingState && existingState.installed === true && existingState.compatibilityMode !== "passive"
  );
  const alreadyInstalled = Boolean(
    existingState && existingState.installed === true && existingState.compatibilityMode === "passive"
  );
  const methodsApplied = [];
  const methodsFailed = [];
  const applyMethod = (name, action) => {
    try {
      action();
      methodsApplied.push(name);
    } catch (error) {
      methodsFailed.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const removeLegacyStyleOverride = () => {
    document.getElementById(styleElementId)?.remove();
  };
  const releaseLegacyRootHandlerProps = () => {
    const targets = [window, document];
    if (document.documentElement) {
      targets.push(document.documentElement);
    }
    if (document.body) {
      targets.push(document.body);
    }
    for (const target of targets) {
      for (const prop of legacyProtectedHandlerProps) {
        const descriptor = Object.getOwnPropertyDescriptor(target, prop);
        if (!descriptor?.configurable || typeof descriptor.get !== "function" || typeof descriptor.set !== "function") {
          continue;
        }
        let descriptorValue;
        try {
          descriptorValue = descriptor.get.call(target);
        } catch {
          descriptorValue = void 0;
        }
        if (descriptorValue === null) {
          delete target[prop];
        }
      }
    }
  };
  const neutralizeLegacyState = () => {
    if (!existingState) {
      return;
    }
    existingState.protectedEventTypes = [];
    existingState.protectedHandlerProps = [];
  };
  if (legacyStateDetected) {
    applyMethod("legacy-style-cleanup", removeLegacyStyleOverride);
    applyMethod("legacy-root-handler-cleanup", releaseLegacyRootHandlerProps);
    applyMethod("legacy-state-neutralized", neutralizeLegacyState);
  }
  win[stateKey] = {
    installed: true,
    compatibilityMode: "passive",
    styleElementId,
    popupHostId,
    updatedAt: (/* @__PURE__ */ new Date()).toISOString()
  };
  applyMethod("passive-page-compatibility", () => void 0);
  return {
    pageUrl: location.href,
    alreadyInstalled,
    methodsApplied,
    methodsFailed
  };
}
var ChromeClipboardAccessGateway;
var init_ChromeClipboardAccessGateway = __esm({
  "src/infrastructure/browser/ChromeClipboardAccessGateway.ts"() {
    "use strict";
    init_browserCapabilities();
    init_errors();
    ChromeClipboardAccessGateway = class {
      async enable(tab) {
        const capabilities = getBrowserCapabilities();
        if (!capabilities.scriptingApi) {
          throw new ExtensionError("This browser does not support script injection required for page copy and paste enablement.");
        }
        const results = await chrome.scripting.executeScript({
          target: { tabId: tab.id, allFrames: true },
          world: "MAIN",
          func: enableClipboardAccessInPage
        });
        const normalizedResults = results.map((result) => this.normalizeFrameResult(result.result, tab.url)).filter((result) => result !== null);
        return {
          tabId: tab.id,
          pageUrl: tab.url,
          frameCount: normalizedResults.length,
          alreadyInstalled: normalizedResults.length > 0 && normalizedResults.every((result) => result.alreadyInstalled),
          methodsApplied: Array.from(new Set(normalizedResults.flatMap((result) => result.methodsApplied))),
          methodsFailed: normalizedResults.flatMap((result) => result.methodsFailed)
        };
      }
      normalizeFrameResult(result, fallbackUrl) {
        if (typeof result !== "object" || result === null) {
          return null;
        }
        const record = result;
        return {
          pageUrl: typeof record.pageUrl === "string" ? record.pageUrl : fallbackUrl,
          alreadyInstalled: Boolean(record.alreadyInstalled),
          methodsApplied: Array.isArray(record.methodsApplied) ? record.methodsApplied.filter((value) => typeof value === "string") : [],
          methodsFailed: Array.isArray(record.methodsFailed) ? record.methodsFailed.filter((value) => typeof value === "string") : []
        };
      }
    };
  }
});

// src/infrastructure/browser/ChromePagePopupGateway.ts
function injectOrUpdatePopupInPage(text, tabId, pageUrl) {
  const popupHostId = "page-signal-capture-popup-host";
  const minimizedSizePx = 40;
  const defaultWidthPx = 280;
  const defaultHeightPx = 220;
  const minimumWidthPx = 220;
  const minimumHeightPx = 180;
  const defaultOpacity = 0.5;
  function updateMeta(textArea2, meta2) {
    const lineCount = textArea2.value.length === 0 ? 0 : textArea2.value.split(/\r\n|\r|\n/).length;
    meta2.textContent = `${textArea2.value.length} chars \xB7 ${lineCount} line${lineCount === 1 ? "" : "s"}`;
  }
  function updateSelectedFileLabel(label, file) {
    if (!file) {
      label.textContent = "No file selected";
      label.dataset.empty = "true";
      return;
    }
    label.textContent = file.name;
    label.dataset.empty = "false";
  }
  function sendRuntimeMessage2(message) {
    try {
      void chrome.runtime.sendMessage(message).catch(() => void 0);
    } catch {
    }
  }
  function clamp(value, minimum, maximum) {
    return Math.min(Math.max(value, minimum), maximum);
  }
  function parseColor(value, fallback) {
    const probe = document.createElement("span");
    probe.style.color = fallback;
    probe.style.color = value;
    const normalized = probe.style.color || fallback;
    const match = normalized.match(/\d+/g);
    if (!match || match.length < 3) {
      return parseColor(fallback, "rgb(255, 255, 255)");
    }
    const [red = 255, green = 255, blue = 255] = match.slice(0, 3).map((part) => clamp(Number.parseInt(part, 10), 0, 255));
    return { red, green, blue };
  }
  function toRgb(color, alpha) {
    return alpha === void 0 ? `rgb(${color.red}, ${color.green}, ${color.blue})` : `rgba(${color.red}, ${color.green}, ${color.blue}, ${alpha})`;
  }
  function mixColors(base, overlay, amount) {
    const ratio = clamp(amount, 0, 1);
    return {
      red: Math.round(base.red + (overlay.red - base.red) * ratio),
      green: Math.round(base.green + (overlay.green - base.green) * ratio),
      blue: Math.round(base.blue + (overlay.blue - base.blue) * ratio)
    };
  }
  function getLuminance(color) {
    const transform = (channel) => {
      const normalized = channel / 255;
      return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
    };
    const red = transform(color.red);
    const green = transform(color.green);
    const blue = transform(color.blue);
    return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
  }
  function getContrastRatio(first, second) {
    const firstLuminance = getLuminance(first);
    const secondLuminance = getLuminance(second);
    const lighter = Math.max(firstLuminance, secondLuminance);
    const darker = Math.min(firstLuminance, secondLuminance);
    return (lighter + 0.05) / (darker + 0.05);
  }
  function chooseReadableText(background, preferred) {
    if (getContrastRatio(background, preferred) >= 4.5) {
      return preferred;
    }
    const black = { red: 17, green: 24, blue: 39 };
    const white = { red: 248, green: 250, blue: 252 };
    return getContrastRatio(background, black) >= getContrastRatio(background, white) ? black : white;
  }
  function applyTheme(host2) {
    const pageStyles = getComputedStyle(document.body || document.documentElement);
    const rootStyles = getComputedStyle(document.documentElement);
    const pageBackground = parseColor(pageStyles.backgroundColor || rootStyles.backgroundColor || "rgb(255, 255, 255)", "rgb(255, 255, 255)");
    const pageForeground = parseColor(pageStyles.color || rootStyles.color || "rgb(17, 24, 39)", "rgb(17, 24, 39)");
    const pageAccent = parseColor(rootStyles.getPropertyValue("a") || pageStyles.color || "rgb(37, 99, 235)", "rgb(37, 99, 235)");
    const darkPage = getLuminance(pageBackground) < 0.45;
    const surface = darkPage ? mixColors(pageBackground, { red: 15, green: 23, blue: 42 }, 0.76) : mixColors(pageBackground, { red: 255, green: 255, blue: 255 }, 0.92);
    const header = darkPage ? mixColors(surface, { red: 255, green: 255, blue: 255 }, 0.06) : mixColors(surface, { red: 15, green: 23, blue: 42 }, 0.04);
    const editor = darkPage ? mixColors(surface, { red: 2, green: 6, blue: 23 }, 0.34) : mixColors(surface, { red: 248, green: 250, blue: 252 }, 0.72);
    const foreground = chooseReadableText(surface, pageForeground);
    const mutedForeground = mixColors(foreground, surface, darkPage ? 0.28 : 0.42);
    const controlBackground = darkPage ? mixColors(surface, { red: 255, green: 255, blue: 255 }, 0.09) : mixColors(surface, { red: 15, green: 23, blue: 42 }, 0.08);
    const border = darkPage ? mixColors(surface, { red: 148, green: 163, blue: 184 }, 0.32) : mixColors(surface, { red: 100, green: 116, blue: 139 }, 0.26);
    const accent = chooseReadableText(header, pageAccent);
    const accentSoft = darkPage ? mixColors(accent, { red: 96, green: 165, blue: 250 }, 0.28) : mixColors(accent, { red: 124, green: 58, blue: 237 }, 0.18);
    const fontFamily = pageStyles.fontFamily || rootStyles.fontFamily || "'Segoe UI', system-ui, sans-serif";
    host2.style.setProperty("--popup-surface", toRgb(surface, 0.96));
    host2.style.setProperty("--popup-surface-strong", toRgb(header, 0.98));
    host2.style.setProperty("--popup-editor", toRgb(editor, 0.98));
    host2.style.setProperty("--popup-border", toRgb(border, darkPage ? 0.48 : 0.38));
    host2.style.setProperty("--popup-foreground", toRgb(foreground));
    host2.style.setProperty("--popup-muted", toRgb(mutedForeground));
    host2.style.setProperty("--popup-control", toRgb(controlBackground, 0.94));
    host2.style.setProperty("--popup-accent", toRgb(accent));
    host2.style.setProperty("--popup-accent-soft", toRgb(accentSoft));
    host2.style.setProperty("--popup-font-family", fontFamily);
    host2.style.setProperty("--popup-shadow", darkPage ? "0 28px 70px rgba(2, 6, 23, 0.52)" : "0 24px 60px rgba(15, 23, 42, 0.22)");
  }
  function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    const CHUNK_SIZE = 32768;
    const parts = [];
    for (let offset = 0; offset < bytes.length; offset += CHUNK_SIZE) {
      const chunk = bytes.subarray(offset, Math.min(offset + CHUNK_SIZE, bytes.length));
      parts.push(String.fromCharCode.apply(null, Array.from(chunk)));
    }
    return btoa(parts.join(""));
  }
  function fileToBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.addEventListener("load", () => {
        const result = typeof reader.result === "string" ? reader.result : "";
        const commaIndex = result.indexOf(",");
        resolve(commaIndex >= 0 ? result.slice(commaIndex + 1) : result);
      });
      reader.addEventListener("error", () => {
        reject(reader.error ?? new Error("FileReader failed to read the selected file."));
      });
      reader.readAsDataURL(file);
    });
  }
  async function copyTextToClipboard(text2) {
    if (typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
      try {
        await navigator.clipboard.write([
          new ClipboardItem({
            "text/plain": new Blob([text2], { type: "text/plain" })
          })
        ]);
        return;
      } catch {
      }
    }
    if (navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(text2);
        return;
      } catch {
      }
    }
    if (copyWithTextarea(text2) || copyWithContentEditable(text2)) {
      return;
    }
    throw new Error("All clipboard copy strategies failed.");
  }
  function copyWithTextarea(text2) {
    const container = document.body ?? document.documentElement;
    if (!container) {
      return false;
    }
    const activeElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const textarea = document.createElement("textarea");
    textarea.value = text2;
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
  function copyWithContentEditable(text2) {
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
    editable.textContent = text2;
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
  function getTextLength(host2) {
    return host2.shadowRoot?.querySelector('[data-role="content"]')?.value.length ?? 0;
  }
  function buildPopupStatus(host2, popupTabId, popupPageUrl, textLength) {
    const state = host2.dataset.popupState === "minimized" ? "minimized" : host2.dataset.popupState === "closed" ? "closed" : "open";
    return {
      exists: state !== "closed",
      state,
      tabId: popupTabId,
      pageUrl: popupPageUrl,
      updatedAt: (/* @__PURE__ */ new Date()).toISOString(),
      textLength
    };
  }
  function sendPopupStatus(host2, popupTabId, popupPageUrl, textLength) {
    const status = buildPopupStatus(host2, popupTabId, popupPageUrl, textLength ?? getTextLength(host2));
    const statusKey = JSON.stringify({
      exists: status.exists,
      state: status.state,
      tabId: status.tabId,
      pageUrl: status.pageUrl,
      textLength: status.textLength
    });
    if (host2.dataset.lastStatusKey === statusKey) {
      return;
    }
    host2.dataset.lastStatusKey = statusKey;
    sendRuntimeMessage2({
      type: "popup-status-update",
      status
    });
  }
  function setPopupState(host2, state, detail) {
    const shell = host2.shadowRoot?.querySelector('[data-role="shell"]');
    if (!shell) {
      return;
    }
    host2.dataset.popupState = state;
    host2.style.display = state === "closed" ? "none" : "block";
    if (state === "minimized") {
      shell.classList.add("minimized");
    } else {
      shell.classList.remove("minimized");
    }
    sendPopupStatus(host2, detail?.tabId ?? null, detail?.pageUrl ?? location.href, detail?.textLength);
  }
  function restorePopup(host2, shell) {
    host2.style.display = "block";
    host2.style.width = `${defaultWidthPx}px`;
    host2.style.height = `${defaultHeightPx}px`;
    host2.style.minWidth = `${minimumWidthPx}px`;
    host2.style.minHeight = `${minimumHeightPx}px`;
    shell.classList.remove("minimized");
    setPopupState(host2, "open");
  }
  function attachDrag(handle, host2, allowInteractiveTarget = false) {
    handle.addEventListener("pointerdown", (event) => {
      if (!allowInteractiveTarget && event.target.closest("button, input")) {
        return;
      }
      event.preventDefault();
      let moved = false;
      const rect = host2.getBoundingClientRect();
      host2.style.left = `${rect.left}px`;
      host2.style.top = `${rect.top}px`;
      host2.style.right = "auto";
      host2.style.bottom = "auto";
      const offsetX = event.clientX - rect.left;
      const offsetY = event.clientY - rect.top;
      const move = (moveEvent) => {
        moved = true;
        host2.style.left = `${Math.max(0, moveEvent.clientX - offsetX)}px`;
        host2.style.top = `${Math.max(0, moveEvent.clientY - offsetY)}px`;
      };
      const stop = () => {
        handle.dataset.dragMoved = moved ? "1" : "0";
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", stop);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", stop, { once: true });
    });
  }
  function attachResize(handle, host2, horizontalDirection, verticalDirection) {
    handle.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const rect = host2.getBoundingClientRect();
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;
      const startLeft = rect.left;
      const startTop = rect.top;
      const startWidth = rect.width;
      const startHeight = rect.height;
      const originX = event.clientX;
      const originY = event.clientY;
      host2.style.left = `${startLeft}px`;
      host2.style.top = `${startTop}px`;
      host2.style.right = "auto";
      host2.style.bottom = "auto";
      const move = (moveEvent) => {
        const deltaX = moveEvent.clientX - originX;
        const deltaY = moveEvent.clientY - originY;
        const nextWidth = clamp(
          horizontalDirection === 1 ? startWidth + deltaX : startWidth - deltaX,
          minimumWidthPx,
          viewportWidth
        );
        const nextHeight = clamp(
          verticalDirection === 1 ? startHeight + deltaY : startHeight - deltaY,
          minimumHeightPx,
          viewportHeight
        );
        const nextLeft = horizontalDirection === -1 ? clamp(startLeft + (startWidth - nextWidth), 0, viewportWidth - nextWidth) : clamp(startLeft, 0, viewportWidth - nextWidth);
        const nextTop = verticalDirection === -1 ? clamp(startTop + (startHeight - nextHeight), 0, viewportHeight - nextHeight) : clamp(startTop, 0, viewportHeight - nextHeight);
        host2.style.width = `${nextWidth}px`;
        host2.style.height = `${nextHeight}px`;
        host2.style.left = `${nextLeft}px`;
        host2.style.top = `${nextTop}px`;
      };
      const stop = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", stop);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", stop, { once: true });
    });
  }
  function createPopupHost() {
    const host2 = document.createElement("div");
    host2.id = popupHostId;
    host2.dataset.popupState = "open";
    host2.style.position = "fixed";
    host2.style.top = "24px";
    host2.style.right = "24px";
    host2.style.width = `${defaultWidthPx}px`;
    host2.style.height = `${defaultHeightPx}px`;
    host2.style.minWidth = `${minimumWidthPx}px`;
    host2.style.minHeight = `${minimumHeightPx}px`;
    host2.style.zIndex = "2147483647";
    host2.style.overflow = "visible";
    host2.style.boxSizing = "border-box";
    host2.style.opacity = String(defaultOpacity);
    return host2;
  }
  function initializePopupDom(host2, shadowRoot2) {
    shadowRoot2.innerHTML = `
      <style>
        :host {
          all: initial;
        }
        .shell {
          position: relative;
          width: 100%;
          height: 100%;
          display: flex;
          flex-direction: column;
          border-radius: 20px;
          overflow: hidden;
          border: 1px solid var(--popup-border);
          background: var(--popup-surface);
          color: var(--popup-foreground);
          box-shadow: var(--popup-shadow);
          backdrop-filter: blur(18px);
          font-family: var(--popup-font-family);
        }
        .shell.minimized {
          width: ${minimizedSizePx}px;
          height: ${minimizedSizePx}px;
          border-radius: 999px;
        }
        .shell.minimized .header,
        .shell.minimized .body,
        .shell.minimized .footer {
          display: none;
        }
        .shell:not(.minimized) .launcher {
          display: none;
        }
        .launcher {
          width: 100%;
          height: 100%;
          display: grid;
          place-items: center;
          border: none;
          background: linear-gradient(135deg, var(--popup-accent), var(--popup-accent-soft));
          color: #fff;
          font: inherit;
          cursor: pointer;
          font-size: 16px;
        }
        .header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 12px 14px;
          gap: 12px;
          background: var(--popup-surface-strong);
          border-bottom: 1px solid var(--popup-border);
          cursor: move;
          user-select: none;
        }
        .title {
          display: flex;
          flex-direction: column;
          gap: 3px;
          min-width: 0;
        }
        .title strong {
          font-size: 13px;
          font-weight: 700;
          letter-spacing: 0.01em;
        }
        .title span {
          font-size: 11px;
          color: var(--popup-muted);
        }
        .controls {
          display: flex;
          gap: 6px;
        }
        button.control,
        button.copy,
        button.upload,
        button.send {
          border: 1px solid transparent;
          border-radius: 10px;
          background: var(--popup-control);
          color: var(--popup-foreground);
          padding: 6px 10px;
          font: inherit;
          font-size: 11px;
          line-height: 1.2;
          cursor: pointer;
          transition: transform 120ms ease, filter 120ms ease, border-color 120ms ease;
        }
        button.control:hover,
        button.copy:hover,
        button.upload:hover,
        button.send:hover,
        .launcher:hover {
          filter: brightness(1.04);
          transform: translateY(-1px);
        }
        button.control:focus-visible,
        button.copy:focus-visible,
        button.upload:focus-visible,
        button.send:focus-visible,
        textarea:focus-visible,
        .resize-handle:focus-visible {
          outline: 2px solid var(--popup-accent);
          outline-offset: 1px;
        }
        .body {
          flex: 1;
          min-height: 0;
          padding: 12px 14px 0;
        }
        textarea {
          width: 100%;
          height: 100%;
          min-height: 0;
          resize: none;
          border: 1px solid var(--popup-border);
          border-radius: 14px;
          background: var(--popup-editor);
          color: var(--popup-foreground);
          padding: 12px;
          box-sizing: border-box;
          font-family: Consolas, 'SFMono-Regular', 'Cascadia Code', monospace;
          font-size: 12px;
          line-height: 1.5;
          white-space: pre;
          caret-color: var(--popup-accent);
        }
        .footer {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 10px 14px 14px;
          gap: 10px;
        }
        .footer-right {
          display: flex;
          align-items: center;
          gap: 10px;
          flex-wrap: wrap;
          justify-content: flex-end;
        }
        .file-pill {
          max-width: 110px;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          font-size: 10px;
          color: var(--popup-muted);
        }
        .file-pill[data-empty="true"] {
          opacity: 0.8;
        }
        .hidden-file-input {
          display: none;
        }
        .meta {
          font-size: 11px;
          color: var(--popup-muted);
        }
        .opacity-wrap {
          display: inline-flex;
          align-items: center;
          gap: 5px;
          font-size: 10px;
          color: var(--popup-muted);
        }
        .opacity-wrap input {
          width: 72px;
        }
        .resize-handle {
          position: absolute;
          width: 14px;
          height: 14px;
          border-radius: 999px;
          background: var(--popup-control);
          border: 1px solid var(--popup-border);
          box-shadow: 0 2px 10px rgba(15, 23, 42, 0.16);
          z-index: 3;
        }
        .resize-handle.nw {
          left: -7px;
          top: -7px;
          cursor: nwse-resize;
        }
        .resize-handle.ne {
          right: -7px;
          top: -7px;
          cursor: nesw-resize;
        }
        .resize-handle.sw {
          left: -7px;
          bottom: -7px;
          cursor: nesw-resize;
        }
        .resize-handle.se {
          right: -7px;
          bottom: -7px;
          cursor: nwse-resize;
        }
        .shell.minimized .resize-handle {
          display: none;
        }
      </style>
      <div class="shell" data-role="shell">
        <button class="launcher" data-role="launcher" title="Restore popup">\u2726</button>
        <button class="resize-handle nw" data-role="resize-nw" title="Resize from top left"></button>
        <button class="resize-handle ne" data-role="resize-ne" title="Resize from top right"></button>
        <button class="resize-handle sw" data-role="resize-sw" title="Resize from bottom left"></button>
        <button class="resize-handle se" data-role="resize-se" title="Resize from bottom right"></button>
        <div class="header" data-role="drag-handle">
          <div class="title">
            <strong>Shared Text</strong>
            <span>Context aware, always readable</span>
          </div>
          <div class="controls">
            <button class="control" data-role="minimize" title="Minimize">\u2212</button>
            <button class="control" data-role="close" title="Close">\xD7</button>
          </div>
        </div>
        <div class="body">
          <textarea data-role="content" spellcheck="false"></textarea>
        </div>
        <div class="footer">
          <span class="meta" data-role="meta">0 chars \xB7 0 lines</span>
          <div class="footer-right">
            <input class="hidden-file-input" data-role="file-input" type="file" />
            <span class="file-pill" data-role="file-name" data-empty="true">No file selected</span>
            <label class="opacity-wrap">
              <span>Opacity</span>
              <input data-role="opacity" type="range" min="0.35" max="1" step="0.05" value="0.5" />
            </label>
            <button class="copy" data-role="copy">Copy</button>
            <button class="upload" data-role="upload" title="Select a file to send to the desktop control center">\u2934</button>
            <button class="send" data-role="send">Send</button>
          </div>
        </div>
      </div>
    `;
    const shell = shadowRoot2.querySelector('[data-role="shell"]');
    const dragHandle = shadowRoot2.querySelector('[data-role="drag-handle"]');
    const minimizeButton = shadowRoot2.querySelector('[data-role="minimize"]');
    const closeButton = shadowRoot2.querySelector('[data-role="close"]');
    const launcher = shadowRoot2.querySelector('[data-role="launcher"]');
    const copyButton = shadowRoot2.querySelector('[data-role="copy"]');
    const uploadButton = shadowRoot2.querySelector('[data-role="upload"]');
    const sendButton = shadowRoot2.querySelector('[data-role="send"]');
    const opacityInput = shadowRoot2.querySelector('[data-role="opacity"]');
    const fileInput = shadowRoot2.querySelector('[data-role="file-input"]');
    const fileNameLabel = shadowRoot2.querySelector('[data-role="file-name"]');
    const textArea2 = shadowRoot2.querySelector('[data-role="content"]');
    const meta2 = shadowRoot2.querySelector('[data-role="meta"]');
    const resizeNorthWest = shadowRoot2.querySelector('[data-role="resize-nw"]');
    const resizeNorthEast = shadowRoot2.querySelector('[data-role="resize-ne"]');
    const resizeSouthWest = shadowRoot2.querySelector('[data-role="resize-sw"]');
    const resizeSouthEast = shadowRoot2.querySelector('[data-role="resize-se"]');
    let pendingStatusTimer = null;
    if (!shell || !dragHandle || !minimizeButton || !closeButton || !launcher || !copyButton || !uploadButton || !sendButton || !opacityInput || !fileInput || !fileNameLabel || !textArea2 || !meta2 || !resizeNorthWest || !resizeNorthEast || !resizeSouthWest || !resizeSouthEast) {
      throw new Error("Popup controls could not be initialized.");
    }
    applyTheme(host2);
    attachDrag(dragHandle, host2);
    attachDrag(launcher, host2, true);
    attachResize(resizeNorthWest, host2, -1, -1);
    attachResize(resizeNorthEast, host2, 1, -1);
    attachResize(resizeSouthWest, host2, -1, 1);
    attachResize(resizeSouthEast, host2, 1, 1);
    const scheduleStatusPublish = (nextTextLength) => {
      if (pendingStatusTimer !== null) {
        window.clearTimeout(pendingStatusTimer);
      }
      pendingStatusTimer = window.setTimeout(() => {
        pendingStatusTimer = null;
        sendPopupStatus(host2, tabId, location.href, nextTextLength);
      }, 120);
    };
    updateSelectedFileLabel(fileNameLabel, null);
    minimizeButton.addEventListener("click", () => {
      host2.style.width = `${minimizedSizePx}px`;
      host2.style.height = `${minimizedSizePx}px`;
      host2.style.minWidth = `${minimizedSizePx}px`;
      host2.style.minHeight = `${minimizedSizePx}px`;
      shell.classList.add("minimized");
      setPopupState(host2, "minimized");
    });
    launcher.addEventListener("click", () => {
      if (launcher.dataset.dragMoved === "1") {
        launcher.dataset.dragMoved = "0";
        return;
      }
      restorePopup(host2, shell);
    });
    closeButton.addEventListener("click", () => {
      setPopupState(host2, "closed", { tabId, pageUrl: location.href, textLength: textArea2.value.length });
    });
    copyButton.addEventListener("click", async () => {
      const originalLabel = copyButton.textContent ?? "Copy";
      copyButton.disabled = true;
      try {
        await copyTextToClipboard(textArea2.value);
        copyButton.textContent = "Copied";
      } catch {
        copyButton.textContent = "Failed";
      } finally {
        window.setTimeout(() => {
          copyButton.textContent = originalLabel;
          copyButton.disabled = false;
        }, 900);
      }
    });
    uploadButton.addEventListener("click", () => {
      fileInput.click();
    });
    fileInput.addEventListener("change", () => {
      updateSelectedFileLabel(fileNameLabel, fileInput.files?.[0] ?? null);
    });
    sendButton.addEventListener("click", async () => {
      const originalLabel = sendButton.textContent ?? "Send";
      sendButton.disabled = true;
      try {
        const selectedFile = fileInput.files?.[0] ?? null;
        const text2 = textArea2.value;
        if (!selectedFile && text2.length === 0) {
          sendButton.textContent = originalLabel;
          sendButton.disabled = false;
          return;
        }
        if (selectedFile) {
          const fileBytesBase64 = await fileToBase64(selectedFile);
          console.log("[page-signal-popup] sending popup-file-send", {
            fileName: selectedFile.name,
            size: selectedFile.size,
            base64Length: fileBytesBase64.length,
            textLength: text2.length
          });
          const response = await chrome.runtime.sendMessage({
            type: "popup-file-send",
            payload: {
              uploadId: crypto.randomUUID(),
              fileName: selectedFile.name,
              mimeType: selectedFile.type || "application/octet-stream",
              byteCount: selectedFile.size,
              fileBytesBase64,
              pageUrl: location.href,
              text: text2
            }
          });
          console.log("[page-signal-popup] popup-file-send response", response);
          if (response && response.ok === false) {
            throw new Error(typeof response.message === "string" ? response.message : "Popup file send rejected.");
          }
        } else {
          await chrome.runtime.sendMessage({
            type: "popup-message-send",
            payload: {
              text: text2,
              pageUrl: location.href
            }
          });
        }
        sendButton.textContent = "Sent";
        fileInput.value = "";
        updateSelectedFileLabel(fileNameLabel, null);
      } catch {
        sendButton.textContent = "Retry";
      } finally {
        window.setTimeout(() => {
          sendButton.textContent = originalLabel;
          sendButton.disabled = false;
        }, 900);
      }
    });
    opacityInput.addEventListener("input", () => {
      host2.style.opacity = opacityInput.value;
    });
    textArea2.addEventListener("input", () => {
      updateMeta(textArea2, meta2);
      scheduleStatusPublish(textArea2.value.length);
    });
    textArea2.addEventListener("keydown", (event) => {
      if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === "a") {
        event.stopPropagation();
      }
    });
  }
  const existingHost = document.getElementById(popupHostId);
  const action = existingHost ? existingHost.dataset.popupState === "minimized" || existingHost.dataset.popupState === "closed" ? "restored" : "updated" : "created";
  const host = existingHost ?? createPopupHost();
  const shadowRoot = host.shadowRoot ?? host.attachShadow({ mode: "open" });
  if (!shadowRoot.hasChildNodes()) {
    initializePopupDom(host, shadowRoot);
  }
  applyTheme(host);
  const textArea = shadowRoot.querySelector('[data-role="content"]');
  const meta = shadowRoot.querySelector('[data-role="meta"]');
  if (!textArea || !meta) {
    throw new Error("Popup DOM initialization failed.");
  }
  const shouldPreserveExistingText = existingHost !== null && existingHost.dataset.popupState === "closed" && text.length === 0;
  if (!shouldPreserveExistingText) {
    textArea.value = text;
  }
  updateMeta(textArea, meta);
  if (!existingHost) {
    document.documentElement.appendChild(host);
  }
  if (action === "restored" || action === "created") {
    setPopupState(host, "open", { tabId, pageUrl, textLength: textArea.value.length });
  } else {
    sendPopupStatus(host, tabId, pageUrl, textArea.value.length);
  }
  return {
    action,
    ...buildPopupStatus(host, tabId, pageUrl, textArea.value.length)
  };
}
function readPopupStatusInPage(tabId, pageUrl) {
  const popupHostId = "page-signal-capture-popup-host";
  const host = document.getElementById(popupHostId);
  if (!host) {
    return {
      exists: false,
      state: "closed",
      tabId,
      pageUrl,
      updatedAt: (/* @__PURE__ */ new Date()).toISOString(),
      textLength: 0
    };
  }
  const textLength = host.shadowRoot?.querySelector('[data-role="content"]')?.value.length ?? 0;
  return {
    exists: host.dataset.popupState !== "closed",
    state: host.dataset.popupState === "minimized" ? "minimized" : host.dataset.popupState === "closed" ? "closed" : "open",
    tabId,
    pageUrl,
    updatedAt: (/* @__PURE__ */ new Date()).toISOString(),
    textLength
  };
}
function closePopupInPage(tabId, pageUrl) {
  const popupHostId = "page-signal-capture-popup-host";
  const host = document.getElementById(popupHostId);
  const textLength = host?.shadowRoot?.querySelector('[data-role="content"]')?.value.length ?? 0;
  if (host) {
    host.dataset.popupState = "closed";
    host.style.display = "none";
  }
  return {
    exists: false,
    state: "closed",
    tabId,
    pageUrl,
    updatedAt: (/* @__PURE__ */ new Date()).toISOString(),
    textLength
  };
}
var ChromePagePopupGateway;
var init_ChromePagePopupGateway = __esm({
  "src/infrastructure/browser/ChromePagePopupGateway.ts"() {
    "use strict";
    init_browserCapabilities();
    init_errors();
    ChromePagePopupGateway = class {
      async show(tab, text) {
        this.ensureScriptingSupport();
        const results = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: injectOrUpdatePopupInPage,
          args: [text, tab.id, tab.url]
        });
        const firstResult = results[0]?.result;
        return this.normalizeShowResult(firstResult, tab);
      }
      async getStatus(tab) {
        this.ensureScriptingSupport();
        const results = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: readPopupStatusInPage,
          args: [tab.id, tab.url]
        });
        const firstResult = results[0]?.result;
        return this.normalizeStatus(firstResult, tab);
      }
      async close(tab) {
        this.ensureScriptingSupport();
        const results = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: closePopupInPage,
          args: [tab.id, tab.url]
        });
        const firstResult = results[0]?.result;
        return this.normalizeStatus(firstResult, tab);
      }
      normalizeShowResult(result, tab) {
        const normalized = this.normalizeStatus(result, tab);
        const action = typeof result === "object" && result !== null && "action" in result && (result.action === "created" || result.action === "updated" || result.action === "restored") ? result.action : "updated";
        return {
          ...normalized,
          action
        };
      }
      normalizeStatus(result, tab) {
        if (typeof result === "object" && result !== null) {
          const resultRecord = result;
          const state = resultRecord.state;
          return {
            exists: Boolean(resultRecord.exists),
            state: state === "open" || state === "minimized" || state === "closed" ? state : "unknown",
            tabId: typeof resultRecord.tabId === "number" ? resultRecord.tabId : tab.id,
            pageUrl: typeof resultRecord.pageUrl === "string" ? resultRecord.pageUrl : tab.url,
            updatedAt: typeof resultRecord.updatedAt === "string" ? resultRecord.updatedAt : (/* @__PURE__ */ new Date()).toISOString(),
            textLength: typeof resultRecord.textLength === "number" ? resultRecord.textLength : 0
          };
        }
        return {
          exists: false,
          state: "unknown",
          tabId: tab.id,
          pageUrl: tab.url,
          updatedAt: (/* @__PURE__ */ new Date()).toISOString(),
          textLength: 0
        };
      }
      ensureScriptingSupport() {
        const capabilities = getBrowserCapabilities();
        if (!capabilities.scriptingApi) {
          throw new ExtensionError("This browser does not support script injection required for the page popup feature.");
        }
      }
    };
  }
});

// src/infrastructure/browser/ChromeScreenShareGateway.ts
var ChromeScreenShareGateway;
var init_ChromeScreenShareGateway = __esm({
  "src/infrastructure/browser/ChromeScreenShareGateway.ts"() {
    "use strict";
    init_errors();
    ChromeScreenShareGateway = class {
      viewerWindowId = null;
      latestStatus = {
        state: "idle",
        active: false,
        viewerWindowId: null,
        sourceLabel: null,
        updatedAt: (/* @__PURE__ */ new Date()).toISOString(),
        message: "Screen share is idle."
      };
      async start() {
        this.ensureSupport();
        if (this.viewerWindowId !== null && (this.latestStatus.active || this.latestStatus.state === "launching")) {
          await this.focusViewerWindow();
          return this.latestStatus;
        }
        const createdWindow = await chrome.windows.create({
          url: chrome.runtime.getURL("screen-share.html"),
          type: "popup",
          focused: true,
          state: "maximized"
        });
        if (!createdWindow) {
          throw new ExtensionError("Chrome did not return a screen share popup window.");
        }
        this.viewerWindowId = typeof createdWindow.id === "number" ? createdWindow.id : null;
        this.latestStatus = {
          state: "launching",
          active: false,
          viewerWindowId: this.viewerWindowId,
          sourceLabel: null,
          updatedAt: (/* @__PURE__ */ new Date()).toISOString(),
          message: "Browser sharing window opened. Click Start Streaming in Chrome to open the picker."
        };
        return this.latestStatus;
      }
      updateStatus(status) {
        this.latestStatus = {
          ...status,
          viewerWindowId: status.viewerWindowId ?? this.viewerWindowId
        };
        this.viewerWindowId = this.latestStatus.viewerWindowId;
        return this.latestStatus;
      }
      handleViewerWindowRemoved(windowId) {
        if (windowId !== this.viewerWindowId) {
          return null;
        }
        this.viewerWindowId = null;
        this.latestStatus = {
          state: "ended",
          active: false,
          viewerWindowId: null,
          sourceLabel: null,
          updatedAt: (/* @__PURE__ */ new Date()).toISOString(),
          message: "Screen share window closed."
        };
        return this.latestStatus;
      }
      getStatus() {
        return this.latestStatus;
      }
      async focusViewerWindow() {
        if (this.viewerWindowId === null) {
          return;
        }
        try {
          await chrome.windows.update(this.viewerWindowId, { focused: true });
        } catch {
          this.viewerWindowId = null;
        }
      }
      ensureSupport() {
        if (!chrome.windows?.create) {
          throw new ExtensionError("This browser does not support extension popup windows required for screen share preview.");
        }
      }
    };
  }
});

// src/infrastructure/browser/ChromeDebuggerClient.ts
var ChromeDebuggerClient;
var init_ChromeDebuggerClient = __esm({
  "src/infrastructure/browser/ChromeDebuggerClient.ts"() {
    "use strict";
    init_browserCapabilities();
    init_errors();
    ChromeDebuggerClient = class {
      async attach(debuggee) {
        this.ensureDebuggerSupport();
        await this.promisify((callback) => chrome.debugger.attach(debuggee, "1.3", callback));
      }
      async detach(debuggee) {
        try {
          await this.promisify((callback) => chrome.debugger.detach(debuggee, callback));
        } catch (error) {
          const message = error instanceof Error ? error.message : "";
          if (!message.includes("Detached while handling command")) {
            throw error;
          }
        }
      }
      async sendCommand(debuggee, method, commandParams) {
        this.ensureDebuggerSupport();
        return new Promise((resolve, reject) => {
          chrome.debugger.sendCommand(debuggee, method, commandParams, (result) => {
            const runtimeError = chrome.runtime.lastError;
            if (runtimeError) {
              reject(new ExtensionError(runtimeError.message ?? "Unknown Chrome runtime error."));
              return;
            }
            resolve(result);
          });
        });
      }
      ensureDebuggerSupport() {
        const capabilities = getBrowserCapabilities();
        if (!capabilities.debuggerApi) {
          throw new ExtensionError("This browser does not support the debugger API required for full-page capture.");
        }
      }
      promisify(executor) {
        return new Promise((resolve, reject) => {
          executor((value) => {
            const runtimeError = chrome.runtime.lastError;
            if (runtimeError) {
              reject(new ExtensionError(runtimeError.message ?? "Unknown Chrome runtime error."));
              return;
            }
            resolve(value);
          });
        });
      }
    };
  }
});

// src/shared/fileName.ts
function buildCaptureFileName(prefix, capturedAt) {
  const timestamp = capturedAt.replace(/[:.]/g, "-");
  return `${prefix}-${timestamp}.png`;
}
var init_fileName = __esm({
  "src/shared/fileName.ts"() {
    "use strict";
  }
});

// src/infrastructure/browser/ChromeFullPageCaptureGateway.ts
var ChromeFullPageCaptureGateway;
var init_ChromeFullPageCaptureGateway = __esm({
  "src/infrastructure/browser/ChromeFullPageCaptureGateway.ts"() {
    "use strict";
    init_browserCapabilities();
    init_constants();
    init_errors();
    init_fileName();
    ChromeFullPageCaptureGateway = class {
      constructor(debuggerClient) {
        this.debuggerClient = debuggerClient;
      }
      debuggerClient;
      async capture(tab, settings) {
        const debuggee = { tabId: tab.id };
        await this.debuggerClient.attach(debuggee);
        let viewportOverridden = false;
        try {
          await this.debuggerClient.sendCommand(debuggee, "Page.enable");
          const layoutMetrics = await this.debuggerClient.sendCommand(debuggee, "Page.getLayoutMetrics");
          const devicePixelRatio = await this.readDevicePixelRatio(tab.id);
          const widthCssPx = Math.max(1, Math.ceil(layoutMetrics.contentSize.width));
          const heightCssPx = Math.max(1, Math.ceil(layoutMetrics.contentSize.height));
          const scale = this.computeCaptureScale(widthCssPx, heightCssPx, devicePixelRatio);
          await this.debuggerClient.sendCommand(debuggee, "Emulation.setDeviceMetricsOverride", {
            width: widthCssPx,
            height: heightCssPx,
            deviceScaleFactor: devicePixelRatio,
            mobile: false
          });
          viewportOverridden = true;
          await this.waitForRelayout(tab.id);
          const result = await this.debuggerClient.sendCommand(debuggee, "Page.captureScreenshot", {
            format: "png",
            fromSurface: true,
            captureBeyondViewport: false,
            clip: {
              x: 0,
              y: 0,
              width: widthCssPx,
              height: heightCssPx,
              scale
            }
          });
          const capturedAt = (/* @__PURE__ */ new Date()).toISOString();
          return {
            tab,
            base64Data: result.data,
            mimeType: "image/png",
            fileName: buildCaptureFileName(settings.fileNamePrefix, capturedAt),
            capturedAt,
            widthCssPx,
            heightCssPx,
            scale
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : "Unknown screenshot failure.";
          throw new ExtensionError(`Full-page capture failed: ${message}`);
        } finally {
          if (viewportOverridden) {
            await this.debuggerClient.sendCommand(debuggee, "Emulation.clearDeviceMetricsOverride").catch(() => void 0);
          }
          await this.debuggerClient.detach(debuggee).catch(() => void 0);
        }
      }
      async waitForRelayout(tabId) {
        const capabilities = getBrowserCapabilities();
        if (!capabilities.scriptingApi) {
          return;
        }
        try {
          await chrome.scripting.executeScript({
            target: { tabId },
            func: () => new Promise((resolve) => {
              requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
            })
          });
        } catch {
        }
      }
      async readDevicePixelRatio(tabId) {
        const capabilities = getBrowserCapabilities();
        if (!capabilities.scriptingApi) {
          throw new ExtensionError("This browser does not support script injection required to inspect page metrics.");
        }
        const results = await chrome.scripting.executeScript({
          target: { tabId },
          func: () => window.devicePixelRatio || 1
        });
        const firstResult = results[0]?.result;
        return typeof firstResult === "number" && Number.isFinite(firstResult) ? firstResult : 1;
      }
      computeCaptureScale(widthCssPx, heightCssPx, devicePixelRatio) {
        const cappedDeviceScale = Math.max(1, devicePixelRatio);
        const dimensionScale = Math.min(MAX_CAPTURE_DIMENSION / widthCssPx, MAX_CAPTURE_DIMENSION / heightCssPx, cappedDeviceScale);
        const areaScale = Math.sqrt(MAX_CAPTURE_AREA / (widthCssPx * heightCssPx));
        const scale = Math.min(cappedDeviceScale, dimensionScale, areaScale);
        if (!Number.isFinite(scale) || scale <= 0) {
          throw new ExtensionError("Computed capture scale is invalid for the current page size.");
        }
        return Number(scale.toFixed(2));
      }
    };
  }
});

// src/infrastructure/browser/ChromeOffscreenBridgeRuntime.ts
var ChromeOffscreenBridgeRuntime;
var init_ChromeOffscreenBridgeRuntime = __esm({
  "src/infrastructure/browser/ChromeOffscreenBridgeRuntime.ts"() {
    "use strict";
    init_browserCapabilities();
    init_constants();
    init_errors();
    ChromeOffscreenBridgeRuntime = class {
      creatingDocumentPromise = null;
      async ensureStarted() {
        if (this.creatingDocumentPromise) {
          await this.creatingDocumentPromise;
          return;
        }
        this.creatingDocumentPromise = this.createDocument();
        try {
          await this.creatingDocumentPromise;
        } finally {
          this.creatingDocumentPromise = null;
        }
      }
      async ensureConnected() {
        const capabilities = getBrowserCapabilities();
        if (!capabilities.runtimeMessaging) {
          throw new ExtensionError("This browser does not support extension runtime messaging required for bridge startup.");
        }
        await this.sendBridgeMessage("bridge-start");
      }
      async reconnect() {
        const capabilities = getBrowserCapabilities();
        if (!capabilities.runtimeMessaging) {
          throw new ExtensionError("This browser does not support extension runtime messaging required for bridge reconnect.");
        }
        await this.sendBridgeMessage("bridge-reconnect");
      }
      async createDocument() {
        const capabilities = getBrowserCapabilities();
        if (!capabilities.offscreenDocument) {
          throw new ExtensionError("This browser does not support offscreen documents required for the desktop bridge.");
        }
        try {
          if (typeof chrome.offscreen.hasDocument === "function" && await chrome.offscreen.hasDocument()) {
            return;
          }
          await chrome.offscreen.createDocument({
            url: OFFSCREEN_DOCUMENT_PATH,
            reasons: [chrome.offscreen.Reason.BLOBS, chrome.offscreen.Reason.CLIPBOARD],
            justification: "Maintain a resilient local WebSocket bridge for desktop-driven screenshot capture and clipboard sync."
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : "";
          const normalizedMessage = message.toLowerCase();
          if (!normalizedMessage.includes("single offscreen") && !normalizedMessage.includes("already exists")) {
            throw new ExtensionError(message || "Unable to create the offscreen bridge document.");
          }
        }
      }
      async sendBridgeMessage(type) {
        let lastError = null;
        for (let attempt = 1; attempt <= 5; attempt += 1) {
          try {
            const response = await chrome.runtime.sendMessage({ type });
            if (!response?.ok) {
              throw new ExtensionError(response?.message ?? `The offscreen document rejected ${type}.`);
            }
            return;
          } catch (error) {
            lastError = error;
            const message2 = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
            const listenerIsStarting = message2.includes("receiving end does not exist") || message2.includes("message port closed");
            if (!listenerIsStarting || attempt === 5) {
              break;
            }
            await new Promise((resolve) => setTimeout(resolve, attempt * 100));
          }
        }
        if (lastError instanceof ExtensionError) {
          throw lastError;
        }
        const message = lastError instanceof Error ? lastError.message : String(lastError ?? "");
        throw new ExtensionError(message || `Unable to deliver ${type} to the offscreen bridge.`);
      }
    };
  }
});

// src/infrastructure/browser/UnsupportedBridgeRuntime.ts
var UnsupportedBridgeRuntime;
var init_UnsupportedBridgeRuntime = __esm({
  "src/infrastructure/browser/UnsupportedBridgeRuntime.ts"() {
    "use strict";
    init_errors();
    UnsupportedBridgeRuntime = class {
      constructor(reason) {
        this.reason = reason;
      }
      reason;
      async ensureStarted() {
        throw new ExtensionError(this.reason);
      }
      async ensureConnected() {
        throw new ExtensionError(this.reason);
      }
      async reconnect() {
        throw new ExtensionError(this.reason);
      }
    };
  }
});

// src/infrastructure/browser/UnsupportedFullPageCaptureGateway.ts
var UnsupportedFullPageCaptureGateway;
var init_UnsupportedFullPageCaptureGateway = __esm({
  "src/infrastructure/browser/UnsupportedFullPageCaptureGateway.ts"() {
    "use strict";
    init_errors();
    UnsupportedFullPageCaptureGateway = class {
      constructor(reason) {
        this.reason = reason;
      }
      reason;
      async capture(_tab, _settings) {
        throw new ExtensionError(this.reason);
      }
    };
  }
});

// src/infrastructure/browser/createBrowserPlatformAdapters.ts
function createBrowserPlatformAdapters() {
  const browserIdentity = getBrowserIdentity();
  const capabilities = getBrowserCapabilities();
  const bridgeRuntime = capabilities.offscreenDocument && capabilities.runtimeMessaging ? new ChromeOffscreenBridgeRuntime() : new UnsupportedBridgeRuntime(
    `${browserIdentity.name} does not support the offscreen bridge APIs required for the desktop connection.`
  );
  const fullPageCaptureGateway = capabilities.debuggerApi && capabilities.scriptingApi ? new ChromeFullPageCaptureGateway(new ChromeDebuggerClient()) : new UnsupportedFullPageCaptureGateway(
    `${browserIdentity.name} does not support the debugger-based full-page capture APIs. Popup, clipboard, and bridge features can still run, but screenshot capture is unavailable.`
  );
  return {
    browserIdentity,
    capabilities,
    bridgeRuntime,
    fullPageCaptureGateway
  };
}
var init_createBrowserPlatformAdapters = __esm({
  "src/infrastructure/browser/createBrowserPlatformAdapters.ts"() {
    "use strict";
    init_browserCapabilities();
    init_ChromeDebuggerClient();
    init_ChromeFullPageCaptureGateway();
    init_ChromeOffscreenBridgeRuntime();
    init_UnsupportedBridgeRuntime();
    init_UnsupportedFullPageCaptureGateway();
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
  const trimmed = typeof value === "string" ? value.trim() : "";
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
  const trimmed = typeof value === "string" ? value.trim() : "";
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
        const fileNamePrefix = typeof settings.fileNamePrefix === "string" ? settings.fileNamePrefix.trim() : "";
        const requestTimeout = Number(settings.requestTimeoutMs);
        const resolverUrl = typeof settings.websocketResolverUrl === "string" && settings.websocketResolverUrl.trim() ? settings.websocketResolverUrl : DEFAULT_WEBSOCKET_RESOLVER_URL;
        return {
          enabled: typeof settings.enabled === "boolean" ? settings.enabled : DEFAULT_SETTINGS.enabled,
          websocketUrl: normalizeWebSocketUrl(settings.websocketUrl),
          websocketResolverUrl: normalizeResolverUrl(resolverUrl),
          fileNamePrefix: fileNamePrefix || DEFAULT_SETTINGS.fileNamePrefix,
          requestTimeoutMs: Number.isFinite(requestTimeout) ? Math.min(12e4, Math.max(1e3, Math.round(requestTimeout))) : DEFAULT_SETTINGS.requestTimeoutMs,
          connectionMode: normalizeConnectionMode(settings.connectionMode),
          relayUrl: normalizeRelayUrl(settings.relayUrl),
          sessionId: normalizeSessionId(settings.sessionId)
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

// src/background/main.ts
var require_main = __commonJS({
  "src/background/main.ts"() {
    init_CaptureCycleService();
    init_BridgeLifecycleService();
    init_constants();
    init_browserCapabilities();
    init_ChromeActiveTabGateway();
    init_ChromeClipboardAccessGateway();
    init_ChromePagePopupGateway();
    init_ChromeScreenShareGateway();
    init_createBrowserPlatformAdapters();
    init_ChromeRunStatusRepository();
    init_ChromeSettingsRepository();
    init_debug();
    var browserPlatform = createBrowserPlatformAdapters();
    var activeTabGateway = new ChromeActiveTabGateway();
    var settingsRepository = new ChromeSettingsRepository();
    var runStatusRepository = new ChromeRunStatusRepository();
    var captureCycleService = new CaptureCycleService(
      settingsRepository,
      activeTabGateway,
      browserPlatform.fullPageCaptureGateway,
      runStatusRepository
    );
    var bridgeLifecycleService = new BridgeLifecycleService(settingsRepository, browserPlatform.bridgeRuntime);
    var clipboardAccessGateway = new ChromeClipboardAccessGateway();
    var pagePopupGateway = new ChromePagePopupGateway();
    var screenShareGateway = new ChromeScreenShareGateway();
    var recentPopupMessages = [];
    var SCREEN_SHARE_STOP_OVERLAY_ID = "page-signal-screen-share-stop";
    var latestPopupStatus = {
      exists: false,
      state: "closed",
      tabId: null,
      pageUrl: null,
      updatedAt: (/* @__PURE__ */ new Date()).toISOString(),
      textLength: 0
    };
    var latestScreenShareStatus = screenShareGateway.getStatus();
    var latestScreenShareOverlayTabId = null;
    debugLog("background", "Detected browser capabilities.", {
      browser: browserPlatform.browserIdentity,
      capabilities: browserPlatform.capabilities
    });
    var unsupportedCapabilities = getUnsupportedCapabilitiesSummary();
    if (unsupportedCapabilities.length > 0) {
      debugError("background", "Some browser capabilities are unavailable. Related features will degrade gracefully.", unsupportedCapabilities);
    }
    async function runCaptureCycle() {
      debugLog("background", "Running capture cycle.");
      return captureCycleService.execute();
    }
    async function ensureBridge() {
      try {
        debugLog("background", "Ensuring offscreen bridge is online.");
        await bridgeLifecycleService.ensureOnline();
        debugLog("background", "running...");
      } catch (error) {
        debugError("background", "Bridge lifecycle sync failed.", error);
      }
    }
    function toBrowserTab(tab) {
      if (!tab?.id || !tab.url || BLOCKED_PROTOCOL_PREFIXES.some((prefix) => tab.url?.startsWith(prefix))) {
        return null;
      }
      return {
        id: tab.id,
        title: tab.title ?? "Untitled page",
        url: tab.url
      };
    }
    async function enableClipboardAccessForTab(tab, trigger) {
      try {
        const result = await clipboardAccessGateway.enable(tab);
        if (result.methodsFailed.length > 0) {
          debugError("background", "Clipboard access enable completed with fallback failures.", {
            trigger,
            ...result
          });
          return;
        }
        debugLog("background", "Clipboard access enable completed.", {
          trigger,
          ...result
        });
      } catch (error) {
        debugError("background", "Clipboard access injection failed; extension will continue normally.", {
          trigger,
          tabId: tab.id,
          pageUrl: tab.url,
          error
        });
      }
    }
    async function enableClipboardAccessOnActiveTab(trigger) {
      const tab = await activeTabGateway.getActiveCapturableTab();
      if (!tab) {
        debugLog("background", "No active tab is available for clipboard access enable.", { trigger });
        return;
      }
      await enableClipboardAccessForTab(tab, trigger);
    }
    async function showPagePopup(text) {
      const tab = await activeTabGateway.getActiveCapturableTab();
      if (!tab) {
        throw new Error("No active capturable tab is available for the browser popup.");
      }
      const result = await pagePopupGateway.show(tab, text);
      latestPopupStatus = result;
      notifyPopupStatusChanged(result);
      return result;
    }
    async function startScreenShare() {
      const result = await screenShareGateway.start();
      latestScreenShareStatus = result;
      notifyScreenShareStatusChanged(result);
      return result;
    }
    async function requestScreenShareStop() {
      const response = await new Promise((resolve) => {
        chrome.runtime.sendMessage({ type: "screen-share-force-stop" }, (result) => {
          const runtimeError = chrome.runtime.lastError;
          if (runtimeError) {
            resolve({ ok: false, message: runtimeError.message });
            return;
          }
          resolve(result ?? { ok: true });
        });
      });
      if (response.ok === false) {
        throw new Error(response.message || "Screen share stop request failed.");
      }
      return latestScreenShareStatus;
    }
    async function resolveScreenShareTabId() {
      let targetTabId = latestScreenShareOverlayTabId;
      if (targetTabId !== null) {
        try {
          await chrome.tabs.get(targetTabId);
        } catch {
          targetTabId = null;
          latestScreenShareOverlayTabId = null;
        }
      }
      if (targetTabId === null) {
        try {
          const candidateTabs = await chrome.tabs.query({ active: true, windowType: "normal" });
          const usable = candidateTabs.find((tab) => {
            if (!tab.id || !tab.url) {
              return false;
            }
            return !BLOCKED_PROTOCOL_PREFIXES.some((prefix) => tab.url.startsWith(prefix));
          });
          if (usable?.id !== void 0) {
            targetTabId = usable.id;
          }
        } catch (error) {
          debugError("background", "Failed to enumerate browser tabs for remote input fallback.", error);
        }
      }
      if (targetTabId === null) {
        const activeTab = await activeTabGateway.getActiveCapturableTab();
        targetTabId = activeTab?.id ?? null;
      }
      if (targetTabId === null) {
        throw new Error("No shared browser tab is available for remote input delivery. Switch to a regular browser tab and retry, or run the native client agent for OS-level control.");
      }
      return targetTabId;
    }
    async function focusScreenShareTab(targetTabId) {
      void targetTabId;
    }
    async function dispatchScreenShareInput(payload) {
      if (!latestScreenShareStatus.active) {
        throw new Error("Screen share is not active. Start sharing before sending remote input.");
      }
      if (!chrome.scripting?.executeScript) {
        throw new Error("This browser cannot inject remote input handlers into the shared page.");
      }
      const targetTabId = await resolveScreenShareTabId();
      await focusScreenShareTab(targetTabId);
      const [result] = await chrome.scripting.executeScript({
        target: { tabId: targetTabId },
        func: (action, xRatio, yRatio, button, buttons, deltaX, deltaY, modifiers, overlayId) => {
          const viewportWidth = Math.max(1, window.innerWidth || document.documentElement.clientWidth || 1);
          const viewportHeight = Math.max(1, window.innerHeight || document.documentElement.clientHeight || 1);
          const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
          const clientX = clamp(Math.round(xRatio * viewportWidth), 0, Math.max(0, viewportWidth - 1));
          const clientY = clamp(Math.round(yRatio * viewportHeight), 0, Math.max(0, viewportHeight - 1));
          const overlay = document.getElementById(overlayId);
          let target = document.elementFromPoint(clientX, clientY);
          if (target && overlay && target === overlay) {
            const previousPointerEvents = overlay.style.pointerEvents;
            overlay.style.pointerEvents = "none";
            target = document.elementFromPoint(clientX, clientY);
            overlay.style.pointerEvents = previousPointerEvents || "auto";
          }
          if (!target) {
            return {
              ok: false,
              message: "No page element was found at the selected point.",
              targetDescription: "none",
              viewportWidth,
              viewportHeight
            };
          }
          const mods = modifiers || {};
          const baseInit = {
            bubbles: true,
            cancelable: true,
            composed: true,
            button,
            buttons,
            clientX,
            clientY,
            view: window,
            ctrlKey: !!mods.ctrl,
            shiftKey: !!mods.shift,
            altKey: !!mods.alt,
            metaKey: !!mods.meta
          };
          const pointerInit = {
            ...baseInit,
            pointerId: 1,
            pointerType: "mouse",
            isPrimary: true
          };
          const dispatchPointerAndMouse = (pointerType, mouseType) => {
            if (typeof PointerEvent !== "undefined") {
              target.dispatchEvent(new PointerEvent(pointerType, pointerInit));
            }
            target.dispatchEvent(new MouseEvent(mouseType, baseInit));
          };
          switch (action) {
            case "pointer-move": {
              dispatchPointerAndMouse("pointermove", "mousemove");
              break;
            }
            case "pointer-down": {
              target.dispatchEvent(new MouseEvent("mouseover", baseInit));
              dispatchPointerAndMouse("pointerdown", "mousedown");
              break;
            }
            case "pointer-up": {
              dispatchPointerAndMouse("pointerup", "mouseup");
              break;
            }
            case "click": {
              target.dispatchEvent(new MouseEvent("mouseover", baseInit));
              target.dispatchEvent(new MouseEvent("mousemove", baseInit));
              if (typeof PointerEvent !== "undefined") {
                target.dispatchEvent(new PointerEvent("pointerdown", pointerInit));
                target.dispatchEvent(new PointerEvent("pointerup", pointerInit));
              }
              target.dispatchEvent(new MouseEvent("mousedown", baseInit));
              target.dispatchEvent(new MouseEvent("mouseup", baseInit));
              target.dispatchEvent(new MouseEvent("click", baseInit));
              if (typeof target.focus === "function") {
                try {
                  target.focus({ preventScroll: true });
                } catch {
                  target.focus();
                }
              }
              if (typeof target.click === "function") {
                target.click();
              }
              break;
            }
            case "double-click": {
              target.dispatchEvent(new MouseEvent("mousedown", baseInit));
              target.dispatchEvent(new MouseEvent("mouseup", baseInit));
              target.dispatchEvent(new MouseEvent("click", baseInit));
              target.dispatchEvent(new MouseEvent("mousedown", baseInit));
              target.dispatchEvent(new MouseEvent("mouseup", baseInit));
              target.dispatchEvent(new MouseEvent("click", baseInit));
              target.dispatchEvent(new MouseEvent("dblclick", baseInit));
              break;
            }
            case "wheel": {
              const wheelInit = {
                ...baseInit,
                deltaX,
                deltaY,
                deltaMode: 0
              };
              const wheelEvent = new WheelEvent("wheel", wheelInit);
              const cancelled = !target.dispatchEvent(wheelEvent);
              if (!cancelled) {
                try {
                  window.scrollBy({ left: deltaX, top: deltaY, behavior: "auto" });
                } catch {
                  window.scrollBy(deltaX, deltaY);
                }
              }
              break;
            }
            default: {
              return {
                ok: false,
                message: `Unsupported remote input action: ${action}`,
                targetDescription: "none",
                viewportWidth,
                viewportHeight
              };
            }
          }
          const targetDescription = [
            target.tagName.toLowerCase(),
            target.id ? `#${target.id}` : "",
            target.className ? `.${String(target.className).trim().replace(/\s+/g, ".")}` : ""
          ].join("").replace(/\.+$/, "") || "page element";
          return {
            ok: true,
            message: `Remote ${action} delivered to ${targetDescription} at ${clientX}, ${clientY}.`,
            targetDescription,
            viewportWidth,
            viewportHeight
          };
        },
        args: [
          payload.action,
          payload.normalizedX,
          payload.normalizedY,
          payload.button ?? 0,
          payload.buttons ?? 0,
          payload.deltaX ?? 0,
          payload.deltaY ?? 0,
          payload.modifiers ?? {},
          SCREEN_SHARE_STOP_OVERLAY_ID
        ]
      });
      if (!result?.result?.ok) {
        throw new Error(result?.result?.message || "Remote input injection failed on the shared page.");
      }
      return result.result;
    }
    async function dispatchScreenShareKey(payload) {
      if (!latestScreenShareStatus.active) {
        throw new Error("Screen share is not active. Start sharing before sending remote key events.");
      }
      if (!chrome.scripting?.executeScript) {
        throw new Error("This browser cannot inject remote key handlers into the shared page.");
      }
      const targetTabId = await resolveScreenShareTabId();
      await focusScreenShareTab(targetTabId);
      const [result] = await chrome.scripting.executeScript({
        target: { tabId: targetTabId },
        func: (action, key, code, text, modifiers) => {
          const describeTarget = (target2) => {
            const el = target2;
            return [
              el.tagName.toLowerCase(),
              el.id ? `#${el.id}` : "",
              el.className ? `.${String(el.className).trim().replace(/\s+/g, ".")}` : ""
            ].join("").replace(/\.+$/, "") || "focused element";
          };
          const getActiveElement = () => {
            let active = document.activeElement;
            while (active && active.shadowRoot) {
              const nested = active.shadowRoot?.activeElement ?? null;
              if (!nested) {
                break;
              }
              active = nested;
            }
            return active ?? document.body;
          };
          const target = getActiveElement();
          if (!target) {
            return { ok: false, message: "No focused element is available for remote key input.", targetDescription: "none" };
          }
          const mods = modifiers || {};
          const init = {
            bubbles: true,
            cancelable: true,
            composed: true,
            key,
            code: code || key,
            ctrlKey: !!mods.ctrl,
            shiftKey: !!mods.shift,
            altKey: !!mods.alt,
            metaKey: !!mods.meta
          };
          const isTextInput = (element) => {
            if (element instanceof HTMLTextAreaElement) {
              return true;
            }
            if (!(element instanceof HTMLInputElement)) {
              return false;
            }
            const allowedTypes = /* @__PURE__ */ new Set(["", "email", "number", "password", "search", "tel", "text", "url"]);
            return allowedTypes.has(element.type);
          };
          const insertTextIntoTarget = (insertText) => {
            if (insertText === "") {
              return true;
            }
            if (isTextInput(target)) {
              if (target.disabled || target.readOnly) {
                return false;
              }
              const start = target.selectionStart ?? target.value.length;
              const end = target.selectionEnd ?? start;
              const next = `${target.value.slice(0, start)}${insertText}${target.value.slice(end)}`;
              target.value = next;
              const caret = start + insertText.length;
              target.setSelectionRange(caret, caret);
              target.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, cancelable: true, data: insertText, inputType: "insertText" }));
              target.dispatchEvent(new InputEvent("input", { bubbles: true, data: insertText, inputType: "insertText" }));
              target.dispatchEvent(new Event("change", { bubbles: true }));
              return true;
            }
            if (target.isContentEditable) {
              const selection = window.getSelection();
              if (!selection) {
                return false;
              }
              let range;
              if (selection.rangeCount > 0) {
                range = selection.getRangeAt(0);
              } else {
                range = document.createRange();
                range.selectNodeContents(target);
                range.collapse(false);
              }
              range.deleteContents();
              const node = document.createTextNode(insertText);
              range.insertNode(node);
              range.setStartAfter(node);
              range.collapse(true);
              selection.removeAllRanges();
              selection.addRange(range);
              target.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, cancelable: true, data: insertText, inputType: "insertText" }));
              target.dispatchEvent(new InputEvent("input", { bubbles: true, data: insertText, inputType: "insertText" }));
              return true;
            }
            return false;
          };
          const handleBackspace = () => {
            if (isTextInput(target)) {
              if (target.disabled || target.readOnly) {
                return false;
              }
              const start = target.selectionStart ?? 0;
              const end = target.selectionEnd ?? start;
              if (start === end) {
                if (start === 0) {
                  return true;
                }
                target.value = `${target.value.slice(0, start - 1)}${target.value.slice(start)}`;
                target.setSelectionRange(start - 1, start - 1);
              } else {
                target.value = `${target.value.slice(0, start)}${target.value.slice(end)}`;
                target.setSelectionRange(start, start);
              }
              target.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward" }));
              return true;
            }
            if (target.isContentEditable) {
              try {
                document.execCommand("delete", false);
                return true;
              } catch {
                return false;
              }
            }
            return false;
          };
          try {
            target.focus({ preventScroll: true });
          } catch {
            try {
              target.focus();
            } catch {
            }
          }
          switch (action) {
            case "down": {
              target.dispatchEvent(new KeyboardEvent("keydown", init));
              if (key && key.length === 1 && !mods.ctrl && !mods.meta && !mods.alt) {
                insertTextIntoTarget(key);
              } else if (key === "Enter" && !mods.ctrl && !mods.meta && !mods.alt) {
                insertTextIntoTarget("\n");
              } else if (key === "Tab" && !mods.ctrl && !mods.meta && !mods.alt) {
                insertTextIntoTarget("	");
              } else if (key === "Backspace") {
                handleBackspace();
              }
              break;
            }
            case "up": {
              target.dispatchEvent(new KeyboardEvent("keyup", init));
              break;
            }
            case "type": {
              if (text) {
                for (const ch of text) {
                  const charInit = { ...init, key: ch, code: "" };
                  target.dispatchEvent(new KeyboardEvent("keydown", charInit));
                  insertTextIntoTarget(ch);
                  target.dispatchEvent(new KeyboardEvent("keyup", charInit));
                }
              }
              break;
            }
            default: {
              return { ok: false, message: `Unsupported remote key action: ${action}`, targetDescription: describeTarget(target) };
            }
          }
          return { ok: true, message: `Remote key ${action} delivered.`, targetDescription: describeTarget(target) };
        },
        args: [
          payload.action,
          payload.key ?? "",
          payload.code ?? "",
          payload.text ?? "",
          payload.modifiers ?? {}
        ]
      });
      if (!result?.result?.ok) {
        throw new Error(result?.result?.message || "Remote key injection failed on the shared page.");
      }
      return result.result;
    }
    async function dispatchScreenShareClick(normalizedX, normalizedY) {
      if (!latestScreenShareStatus.active) {
        throw new Error("Screen share is not active. Start sharing before sending remote clicks.");
      }
      if (!chrome.scripting?.executeScript) {
        throw new Error("This browser cannot inject remote click handlers into the shared page.");
      }
      const targetTabId = await resolveScreenShareTabId();
      await focusScreenShareTab(targetTabId);
      const [result] = await chrome.scripting.executeScript({
        target: { tabId: targetTabId },
        func: (xRatio, yRatio, overlayId) => {
          const viewportWidth = Math.max(1, window.innerWidth || document.documentElement.clientWidth || 1);
          const viewportHeight = Math.max(1, window.innerHeight || document.documentElement.clientHeight || 1);
          const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
          const clientX = clamp(Math.round(xRatio * viewportWidth), 0, Math.max(0, viewportWidth - 1));
          const clientY = clamp(Math.round(yRatio * viewportHeight), 0, Math.max(0, viewportHeight - 1));
          const overlay = document.getElementById(overlayId);
          let target = document.elementFromPoint(clientX, clientY);
          if (target && overlay && target === overlay) {
            const previousPointerEvents = overlay.style.pointerEvents;
            overlay.style.pointerEvents = "none";
            target = document.elementFromPoint(clientX, clientY);
            overlay.style.pointerEvents = previousPointerEvents || "auto";
          }
          if (!target) {
            return {
              ok: false,
              message: "No page element was found at the selected point.",
              targetDescription: "none",
              viewportWidth,
              viewportHeight
            };
          }
          const eventInit = {
            bubbles: true,
            cancelable: true,
            composed: true,
            button: 0,
            buttons: 1,
            clientX,
            clientY,
            view: window
          };
          if (typeof PointerEvent !== "undefined") {
            const pointerInit = {
              ...eventInit,
              pointerId: 1,
              pointerType: "mouse",
              isPrimary: true
            };
            target.dispatchEvent(new PointerEvent("pointerdown", pointerInit));
            target.dispatchEvent(new PointerEvent("pointerup", pointerInit));
          }
          target.dispatchEvent(new MouseEvent("mouseover", eventInit));
          target.dispatchEvent(new MouseEvent("mousemove", eventInit));
          target.dispatchEvent(new MouseEvent("mousedown", eventInit));
          target.dispatchEvent(new MouseEvent("mouseup", eventInit));
          target.dispatchEvent(new MouseEvent("click", eventInit));
          if (typeof target.focus === "function") {
            try {
              target.focus({ preventScroll: true });
            } catch {
              target.focus();
            }
          }
          if (typeof target.click === "function") {
            target.click();
          }
          const targetDescription = [target.tagName.toLowerCase(), target.id ? `#${target.id}` : "", target.className ? `.${String(target.className).trim().replace(/\s+/g, ".")}` : ""].join("").replace(/\.+$/, "");
          return {
            ok: true,
            message: `Remote click delivered to ${targetDescription || "the shared page"} at ${clientX}, ${clientY}.`,
            targetDescription: targetDescription || "page element",
            viewportWidth,
            viewportHeight
          };
        },
        args: [normalizedX, normalizedY, SCREEN_SHARE_STOP_OVERLAY_ID]
      });
      if (!result?.result?.ok) {
        throw new Error(result?.result?.message || "Remote click injection failed on the shared page.");
      }
      return result.result;
    }
    async function dispatchScreenSharePaste(text) {
      if (!latestScreenShareStatus.active) {
        throw new Error("Screen share is not active. Start sharing before sending remote paste.");
      }
      if (!chrome.scripting?.executeScript) {
        throw new Error("This browser cannot inject remote paste handlers into the shared page.");
      }
      const targetTabId = await resolveScreenShareTabId();
      await focusScreenShareTab(targetTabId);
      const [result] = await chrome.scripting.executeScript({
        target: { tabId: targetTabId },
        func: (clipboardText) => {
          const describeTarget = (target) => {
            return [
              target.tagName.toLowerCase(),
              target.id ? `#${target.id}` : "",
              target.className ? `.${String(target.className).trim().replace(/\s+/g, ".")}` : ""
            ].join("").replace(/\.+$/, "") || "focused element";
          };
          const getActiveElement = () => {
            let active = document.activeElement;
            while (active && active.shadowRoot) {
              const nestedActive = active.shadowRoot?.activeElement ?? null;
              if (!nestedActive) {
                break;
              }
              active = nestedActive;
            }
            return active;
          };
          const isTextInput = (element) => {
            if (element instanceof HTMLTextAreaElement) {
              return true;
            }
            if (!(element instanceof HTMLInputElement)) {
              return false;
            }
            const allowedTypes = /* @__PURE__ */ new Set(["", "email", "number", "password", "search", "tel", "text", "url"]);
            return allowedTypes.has(element.type);
          };
          const activeElement = getActiveElement();
          if (!activeElement) {
            return { ok: false, message: "No focused element is available on the shared page.", targetDescription: "none", characterCount: 0 };
          }
          if (activeElement instanceof HTMLElement) {
            try {
              activeElement.focus({ preventScroll: true });
            } catch {
              activeElement.focus();
            }
          }
          const targetDescription = describeTarget(activeElement);
          if (isTextInput(activeElement)) {
            if (activeElement.disabled || activeElement.readOnly) {
              return { ok: false, message: "The focused field cannot be edited.", targetDescription, characterCount: 0 };
            }
            const selectionStart = activeElement.selectionStart ?? activeElement.value.length;
            const selectionEnd = activeElement.selectionEnd ?? selectionStart;
            const nextValue = `${activeElement.value.slice(0, selectionStart)}${clipboardText}${activeElement.value.slice(selectionEnd)}`;
            activeElement.value = nextValue;
            const nextCaret = selectionStart + clipboardText.length;
            activeElement.setSelectionRange(nextCaret, nextCaret);
            activeElement.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, cancelable: true, data: clipboardText, inputType: "insertFromPaste" }));
            activeElement.dispatchEvent(new InputEvent("input", { bubbles: true, data: clipboardText, inputType: "insertFromPaste" }));
            activeElement.dispatchEvent(new Event("change", { bubbles: true }));
            return {
              ok: true,
              message: `Pasted ${clipboardText.length} character(s) into ${targetDescription}.`,
              targetDescription,
              characterCount: clipboardText.length
            };
          }
          if (activeElement.isContentEditable) {
            const selection = window.getSelection();
            if (!selection) {
              return { ok: false, message: "The focused editable region does not expose a selection.", targetDescription, characterCount: 0 };
            }
            let range;
            if (selection.rangeCount > 0) {
              range = selection.getRangeAt(0);
            } else {
              range = document.createRange();
              range.selectNodeContents(activeElement);
              range.collapse(false);
            }
            range.deleteContents();
            const textNode = document.createTextNode(clipboardText);
            range.insertNode(textNode);
            range.setStartAfter(textNode);
            range.collapse(true);
            selection.removeAllRanges();
            selection.addRange(range);
            activeElement.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, cancelable: true, data: clipboardText, inputType: "insertFromPaste" }));
            activeElement.dispatchEvent(new InputEvent("input", { bubbles: true, data: clipboardText, inputType: "insertFromPaste" }));
            return {
              ok: true,
              message: `Pasted ${clipboardText.length} character(s) into ${targetDescription}.`,
              targetDescription,
              characterCount: clipboardText.length
            };
          }
          return {
            ok: false,
            message: "The focused element is not a text input, textarea, or editable region.",
            targetDescription,
            characterCount: 0
          };
        },
        args: [text]
      });
      if (!result?.result?.ok) {
        throw new Error(result?.result?.message || "Remote paste injection failed on the shared page.");
      }
      return result.result;
    }
    function sanitizeDownloadFileName(fileName) {
      const trimmed = fileName.trim();
      const sanitized = trimmed.replace(/[\\/:*?"<>|]+/g, "_").replace(/^\.+/, "");
      return sanitized || "download.bin";
    }
    async function startManagedBrowserDownload(objectUrl, fileName) {
      const safeFileName = sanitizeDownloadFileName(fileName);
      const downloadId = await chrome.downloads.download({
        url: objectUrl,
        filename: safeFileName,
        conflictAction: "uniquify",
        saveAs: false
      });
      if (typeof downloadId !== "number") {
        throw new Error("Browser download could not be started.");
      }
      return {
        savedPath: safeFileName,
        message: `${safeFileName} download started in the browser.`,
        downloadId
      };
    }
    async function startTabTriggeredBrowserDownload(fileName, mimeType, fileBytes) {
      if (!chrome.scripting?.executeScript) {
        throw new Error("This browser does not support file save fallback injection.");
      }
      const tab = await activeTabGateway.getActiveCapturableTab();
      if (!tab) {
        throw new Error("No active browser tab is available to receive the file.");
      }
      const safeFileName = sanitizeDownloadFileName(fileName);
      const byteArray = Array.from(new Uint8Array(fileBytes));
      const [result] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: (downloadFileName, downloadMimeType, bytes) => {
          const blob = new Blob([new Uint8Array(bytes)], { type: downloadMimeType || "application/octet-stream" });
          const objectUrl = URL.createObjectURL(blob);
          const anchor = document.createElement("a");
          anchor.href = objectUrl;
          anchor.download = downloadFileName;
          anchor.rel = "noopener";
          anchor.style.display = "none";
          (document.body ?? document.documentElement).appendChild(anchor);
          anchor.click();
          anchor.remove();
          window.setTimeout(() => URL.revokeObjectURL(objectUrl), 15e3);
          return {
            ok: true,
            savedPath: downloadFileName,
            message: `${downloadFileName} save was triggered in the browser tab.`
          };
        },
        args: [safeFileName, mimeType || "application/octet-stream", byteArray]
      });
      if (!result?.result?.ok) {
        throw new Error(result?.result?.message || "The browser tab could not start the file save flow.");
      }
      return result.result;
    }
    async function startBrowserDownload(objectUrl, fileName, mimeType, fileBytes) {
      if (browserPlatform.capabilities.downloadsApi) {
        try {
          return await startManagedBrowserDownload(objectUrl, fileName);
        } catch (error) {
          debugError("background", "Managed browser download failed; falling back to tab-triggered save.", error);
        }
      }
      return startTabTriggeredBrowserDownload(fileName, mimeType, fileBytes);
    }
    async function forwardPopupFileUploadToBridge(payload) {
      await ensureBridge();
      return await new Promise((resolve, reject) => {
        chrome.runtime.sendMessage({ type: "popup-file-upload", payload }, (response) => {
          const runtimeError = chrome.runtime.lastError;
          if (runtimeError) {
            reject(new Error(runtimeError.message));
            return;
          }
          resolve(response ?? { ok: false, message: "No response from offscreen bridge." });
        });
      });
    }
    async function closePagePopup() {
      const tab = await activeTabGateway.getActiveCapturableTab();
      if (!tab) {
        latestPopupStatus = {
          exists: false,
          state: "closed",
          tabId: null,
          pageUrl: null,
          updatedAt: (/* @__PURE__ */ new Date()).toISOString(),
          textLength: 0
        };
        notifyPopupStatusChanged(latestPopupStatus);
        return latestPopupStatus;
      }
      const result = await pagePopupGateway.close(tab);
      latestPopupStatus = result;
      notifyPopupStatusChanged(result);
      return result;
    }
    async function togglePagePopup() {
      const status = await readPopupStatus();
      if (status.exists) {
        debugLog("background", "Popup already exists on active tab; closing it from keyboard command.", status);
        return closePagePopup();
      }
      debugLog("background", "Popup is not present on active tab; opening it from keyboard command.");
      return showPagePopup("");
    }
    async function readPopupStatus() {
      const tab = await activeTabGateway.getActiveCapturableTab();
      if (!tab) {
        latestPopupStatus = {
          exists: false,
          state: "closed",
          tabId: null,
          pageUrl: null,
          updatedAt: (/* @__PURE__ */ new Date()).toISOString(),
          textLength: 0
        };
        return latestPopupStatus;
      }
      latestPopupStatus = await pagePopupGateway.getStatus(tab);
      return latestPopupStatus;
    }
    function notifyPopupStatusChanged(status) {
      void chrome.runtime.sendMessage({ type: "popup-status-changed", status }).catch(() => void 0);
    }
    function notifyScreenShareStatusChanged(status) {
      void chrome.runtime.sendMessage({ type: "screen-share-status-changed", status }).catch(() => void 0);
    }
    function notifyPopupMessage(payload) {
      void chrome.runtime.sendMessage({ type: "popup-page-message", payload }).catch(() => void 0);
    }
    function recordPopupMessage(payload) {
      recentPopupMessages.unshift(payload);
      if (recentPopupMessages.length > 2) {
        recentPopupMessages.length = 2;
      }
    }
    async function syncScreenShareClientControls(status) {
      if (status.active) {
        const tab = await activeTabGateway.getActiveCapturableTab();
        if (!tab) {
          return;
        }
        latestScreenShareOverlayTabId = tab.id;
        await injectScreenShareStopOverlay(tab.id);
        return;
      }
      if (latestScreenShareOverlayTabId !== null) {
        await removeScreenShareStopOverlay(latestScreenShareOverlayTabId);
        latestScreenShareOverlayTabId = null;
      }
    }
    async function injectScreenShareStopOverlay(tabId) {
      if (!chrome.scripting?.executeScript) {
        return;
      }
      await chrome.scripting.executeScript({
        target: { tabId },
        func: (overlayId) => {
          const existing = document.getElementById(overlayId);
          if (existing) {
            return;
          }
          const button = document.createElement("button");
          button.id = overlayId;
          button.type = "button";
          button.textContent = "Stop Sharing";
          button.style.position = "fixed";
          button.style.top = "14px";
          button.style.right = "14px";
          button.style.zIndex = "2147483647";
          button.style.border = "1px solid rgba(15, 23, 42, 0.18)";
          button.style.borderRadius = "999px";
          button.style.padding = "10px 16px";
          button.style.background = "linear-gradient(135deg, #dc2626, #ef4444)";
          button.style.color = "#fff";
          button.style.font = "600 13px Segoe UI, system-ui, sans-serif";
          button.style.boxShadow = "0 18px 32px rgba(15, 23, 42, 0.28)";
          button.style.cursor = "pointer";
          button.style.pointerEvents = "auto";
          button.addEventListener("click", () => {
            void chrome.runtime.sendMessage({ type: "screen-share-stop-request" }).catch(() => void 0);
          });
          document.documentElement.appendChild(button);
        },
        args: [SCREEN_SHARE_STOP_OVERLAY_ID]
      });
    }
    async function removeScreenShareStopOverlay(tabId) {
      if (!chrome.scripting?.executeScript) {
        return;
      }
      await chrome.scripting.executeScript({
        target: { tabId },
        func: (overlayId) => {
          document.getElementById(overlayId)?.remove();
        },
        args: [SCREEN_SHARE_STOP_OVERLAY_ID]
      }).catch(() => void 0);
    }
    chrome.runtime.onInstalled.addListener(() => {
      debugLog("background", "Extension installed event received.");
      void ensureBridge();
      void enableClipboardAccessOnActiveTab("runtime-installed");
    });
    chrome.runtime.onStartup.addListener(() => {
      debugLog("background", "Extension startup event received.");
      void ensureBridge();
      void enableClipboardAccessOnActiveTab("runtime-startup");
    });
    chrome.tabs?.onActivated?.addListener((activeInfo) => {
      void (async () => {
        try {
          const tab = toBrowserTab(await chrome.tabs.get(activeInfo.tabId));
          if (!tab) {
            return;
          }
          await enableClipboardAccessForTab(tab, "tab-activated");
        } catch (error) {
          debugError("background", "Clipboard access enable failed on tab activation; continuing normally.", error);
        }
      })();
    });
    chrome.tabs?.onUpdated?.addListener((tabId, changeInfo, tab) => {
      if (changeInfo.status !== "complete" || !tab.active) {
        return;
      }
      const browserTab = toBrowserTab({ ...tab, id: tab.id ?? tabId });
      if (!browserTab) {
        return;
      }
      void enableClipboardAccessForTab(browserTab, "tab-updated");
    });
    chrome.windows?.onRemoved?.addListener((windowId) => {
      const status = screenShareGateway.handleViewerWindowRemoved(windowId);
      if (!status) {
        return;
      }
      latestScreenShareStatus = status;
      notifyScreenShareStatusChanged(status);
    });
    chrome.commands?.onCommand.addListener((command) => {
      void (async () => {
        try {
          await ensureBridge();
          if (command === "toggle-popup") {
            debugLog("background", "Keyboard command received for popup toggle.");
            await togglePagePopup();
          }
        } catch (error) {
          debugError("background", "Keyboard popup toggle failed.", error);
        }
      })();
    });
    chrome.storage?.onChanged?.addListener((changes, areaName) => {
      if (areaName === "sync" && changes[SETTINGS_STORAGE_KEY]) {
        debugLog("background", "Settings changed, restarting bridge.", changes[SETTINGS_STORAGE_KEY]);
        void ensureBridge();
      }
    });
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      debugLog("background", "Received runtime message.", message?.type ?? "unknown");
      if (message?.type === "storage-get") {
        void (async () => {
          try {
            const storageArea = resolveStorageArea(message.area);
            const storageResult = await storageArea.get(message.key);
            sendResponse({ ok: true, value: storageResult[message.key] });
          } catch (error) {
            const messageText = error instanceof Error ? error.message : "Storage read failed.";
            debugError("background", "Storage read failed.", { area: message.area, key: message.key, error: messageText });
            sendResponse({ ok: false, message: messageText });
          }
        })();
        return true;
      }
      if (message?.type === "storage-set") {
        void (async () => {
          try {
            const storageArea = resolveStorageArea(message.area);
            await storageArea.set({ [message.key]: message.value });
            sendResponse({ ok: true });
          } catch (error) {
            const messageText = error instanceof Error ? error.message : "Storage write failed.";
            debugError("background", "Storage write failed.", { area: message.area, key: message.key, error: messageText });
            sendResponse({ ok: false, message: messageText });
          }
        })();
        return true;
      }
      if (message?.type === "capture-now") {
        void runCaptureCycle().then((capturedPage) => sendResponse({ ok: true, capturedPage })).catch((error) => {
          const messageText = error instanceof Error ? error.message : "Capture failed.";
          debugError("background", "Manual capture failed.", messageText);
          sendResponse({ ok: false, message: messageText });
        });
        return true;
      }
      if (message?.type === "bridge-capture-request") {
        void runCaptureCycle().then((capturedPage) => sendResponse({ ok: true, capturedPage })).catch((error) => {
          const messageText = error instanceof Error ? error.message : "Capture failed.";
          debugError("background", "Bridge capture request failed.", messageText);
          sendResponse({ ok: false, message: messageText });
        });
        return true;
      }
      if (message?.type === "ensure-bridge") {
        void ensureBridge().then(() => sendResponse({ ok: true })).catch((error) => {
          const messageText = error instanceof Error ? error.message : "Bridge startup failed.";
          debugError("background", "Bridge ensure request failed.", messageText);
          sendResponse({ ok: false, message: messageText });
        });
        return true;
      }
      if (message?.type === "reconnect-bridge") {
        void bridgeLifecycleService.forceReconnect().then(() => sendResponse({ ok: true })).catch((error) => {
          const messageText = error instanceof Error ? error.message : "Bridge reconnect failed.";
          debugError("background", "Bridge reconnect request failed.", messageText);
          sendResponse({ ok: false, message: messageText });
        });
        return true;
      }
      if (message?.type === "bridge-popup-show") {
        void showPagePopup(String(message.text ?? "")).then((status) => sendResponse({ ok: true, status, action: status.action })).catch((error) => {
          const messageText = error instanceof Error ? error.message : "Popup creation failed.";
          debugError("background", "Bridge popup request failed.", messageText);
          sendResponse({ ok: false, message: messageText });
        });
        return true;
      }
      if (message?.type === "bridge-screen-share-start") {
        void startScreenShare().then((status) => sendResponse({ ok: true, status })).catch((error) => {
          const messageText = error instanceof Error ? error.message : "Screen share start failed.";
          debugError("background", "Bridge screen share request failed.", messageText);
          sendResponse({ ok: false, message: messageText, status: latestScreenShareStatus });
        });
        return true;
      }
      if (message?.type === "bridge-screen-share-stop") {
        void requestScreenShareStop().then((status) => sendResponse({ ok: true, status })).catch((error) => {
          const messageText = error instanceof Error ? error.message : "Screen share stop failed.";
          debugError("background", "Bridge screen share stop request failed.", messageText);
          sendResponse({ ok: false, message: messageText, status: latestScreenShareStatus });
        });
        return true;
      }
      if (message?.type === "bridge-screen-share-click") {
        void dispatchScreenShareClick(Number(message.normalizedX), Number(message.normalizedY)).then((result) => sendResponse({ ...result, ok: true })).catch((error) => {
          const messageText = error instanceof Error ? error.message : "Screen share click failed.";
          debugError("background", "Bridge screen share click request failed.", messageText);
          sendResponse({ ok: false, message: messageText });
        });
        return true;
      }
      if (message?.type === "bridge-screen-share-paste") {
        void dispatchScreenSharePaste(String(message.text ?? "")).then((result) => sendResponse({ ...result, ok: true })).catch((error) => {
          const messageText = error instanceof Error ? error.message : "Screen share paste failed.";
          debugError("background", "Bridge screen share paste request failed.", messageText);
          sendResponse({ ok: false, message: messageText });
        });
        return true;
      }
      if (message?.type === "bridge-screen-share-input") {
        void dispatchScreenShareInput(message.payload ?? {}).then((result) => sendResponse({ ...result, ok: true })).catch((error) => {
          const messageText = error instanceof Error ? error.message : "Screen share input failed.";
          debugError("background", "Bridge screen share input request failed.", messageText);
          sendResponse({ ok: false, message: messageText });
        });
        return true;
      }
      if (message?.type === "bridge-screen-share-key") {
        void dispatchScreenShareKey(message.payload ?? {}).then((result) => sendResponse({ ...result, ok: true })).catch((error) => {
          const messageText = error instanceof Error ? error.message : "Screen share key failed.";
          debugError("background", "Bridge screen share key request failed.", messageText);
          sendResponse({ ok: false, message: messageText });
        });
        return true;
      }
      if (message?.type === "bridge-browser-download") {
        void startBrowserDownload(
          String(message.objectUrl ?? ""),
          String(message.fileName ?? "download.bin"),
          String(message.mimeType ?? "application/octet-stream"),
          message.fileBytes instanceof ArrayBuffer ? message.fileBytes : new ArrayBuffer(0)
        ).then((result) => sendResponse({ ...result, ok: true })).catch((error) => {
          const messageText = error instanceof Error ? error.message : "Browser download failed.";
          debugError("background", "Bridge browser download request failed.", messageText);
          sendResponse({ ok: false, message: messageText });
        });
        return true;
      }
      if (message?.type === "popup-status-get") {
        void readPopupStatus().then((status) => sendResponse({ ok: true, status })).catch((error) => {
          const messageText = error instanceof Error ? error.message : "Popup status lookup failed.";
          debugError("background", "Popup status lookup failed.", messageText);
          sendResponse({ ok: false, message: messageText, status: latestPopupStatus });
        });
        return true;
      }
      if (message?.type === "popup-message-history-get") {
        sendResponse({ ok: true, messages: [...recentPopupMessages] });
        return true;
      }
      if (message?.type === "popup-status-update") {
        latestPopupStatus = {
          exists: Boolean(message.status?.exists),
          state: message.status?.state === "open" || message.status?.state === "minimized" || message.status?.state === "closed" ? message.status.state : "unknown",
          tabId: typeof message.status?.tabId === "number" ? message.status.tabId : null,
          pageUrl: typeof message.status?.pageUrl === "string" ? message.status.pageUrl : null,
          updatedAt: typeof message.status?.updatedAt === "string" ? message.status.updatedAt : (/* @__PURE__ */ new Date()).toISOString(),
          textLength: typeof message.status?.textLength === "number" ? message.status.textLength : 0
        };
        notifyPopupStatusChanged(latestPopupStatus);
        sendResponse({ ok: true });
        return true;
      }
      if (message?.type === "popup-message-send") {
        const text = typeof message.payload?.text === "string" ? message.payload.text : "";
        const payload = {
          text,
          pageUrl: sender.tab?.url ?? (typeof message.payload?.pageUrl === "string" ? message.payload.pageUrl : null),
          tabId: sender.tab?.id ?? (typeof message.payload?.tabId === "number" ? message.payload.tabId : null),
          sentAt: (/* @__PURE__ */ new Date()).toISOString()
        };
        debugLog("background", "Received popup text from page.", {
          tabId: payload.tabId,
          pageUrl: payload.pageUrl,
          characters: text.length
        });
        recordPopupMessage(payload);
        notifyPopupMessage(payload);
        sendResponse({ ok: true });
        return true;
      }
      if (message?.type === "popup-file-send") {
        void (async () => {
          try {
            const fileName = typeof message.payload?.fileName === "string" && message.payload.fileName.trim() ? message.payload.fileName.trim() : "client-upload.bin";
            const mimeType = typeof message.payload?.mimeType === "string" && message.payload.mimeType.trim() ? message.payload.mimeType.trim() : "application/octet-stream";
            const fileBytesBase64 = typeof message.payload?.fileBytesBase64 === "string" ? message.payload.fileBytesBase64 : "";
            const popupText = typeof message.payload?.text === "string" ? message.payload.text : "";
            const pageUrl = sender.tab?.url ?? (typeof message.payload?.pageUrl === "string" ? message.payload.pageUrl : null);
            const tabId = sender.tab?.id ?? (typeof message.payload?.tabId === "number" ? message.payload.tabId : null);
            const sentAt = (/* @__PURE__ */ new Date()).toISOString();
            if (!fileBytesBase64) {
              throw new Error("The popup file upload did not contain a base64 binary payload.");
            }
            debugLog("background", "Forwarding popup file upload to bridge.", { fileName, mimeType, base64Length: fileBytesBase64.length, textLength: popupText.length });
            const response = await forwardPopupFileUploadToBridge({
              uploadId: typeof message.payload?.uploadId === "string" && message.payload.uploadId ? message.payload.uploadId : crypto.randomUUID(),
              fileName,
              mimeType,
              byteCount: typeof message.payload?.byteCount === "number" ? message.payload.byteCount : 0,
              fileBytesBase64,
              pageUrl,
              tabId,
              sentAt,
              text: popupText
            });
            if (!response.ok) {
              throw new Error(response.message || "The offscreen bridge rejected the popup file upload.");
            }
            if (popupText.length > 0) {
              const textPayload = { text: popupText, pageUrl, tabId, sentAt };
              recordPopupMessage(textPayload);
              notifyPopupMessage(textPayload);
            }
            sendResponse({ ok: true, message: response.message ?? `${fileName} sent to the desktop control center.` });
          } catch (error) {
            const messageText = error instanceof Error ? error.message : "Popup file upload failed.";
            debugError("background", "Popup file upload failed.", messageText);
            sendResponse({ ok: false, message: messageText });
          }
        })();
        return true;
      }
      if (message?.type === "screen-share-status-get") {
        sendResponse({ ok: true, status: latestScreenShareStatus });
        return true;
      }
      if (message?.type === "screen-share-viewer-ready") {
        sendResponse({ ok: true, status: latestScreenShareStatus });
        return true;
      }
      if (message?.type === "screen-share-stream-endpoint-get") {
        void (async () => {
          try {
            const [runStatus, settings] = await Promise.all([
              runStatusRepository.get(),
              settingsRepository.get()
            ]);
            const fallbackTarget = settings.connectionMode === "relay" && settings.relayUrl ? settings.relayUrl : settings.websocketUrl;
            sendResponse({
              ok: true,
              targetUrl: runStatus.targetUrl ?? fallbackTarget,
              sessionId: settings.sessionId
            });
          } catch (error) {
            const messageText = error instanceof Error ? error.message : "Screen share stream endpoint lookup failed.";
            debugError("background", "Screen share stream endpoint lookup failed.", messageText);
            sendResponse({ ok: false, message: messageText });
          }
        })();
        return true;
      }
      if (message?.type === "screen-share-get-tab-stream-id") {
        void (async () => {
          try {
            const consumerTabId = sender?.tab?.id;
            if (typeof consumerTabId !== "number") {
              throw new Error("Screen share popup tab id is unavailable.");
            }
            const candidateTabs = await chrome.tabs.query({ active: true, windowType: "normal" });
            const usable = candidateTabs.find((tab) => {
              if (!tab.id || !tab.url) {
                return false;
              }
              return !BLOCKED_PROTOCOL_PREFIXES.some((prefix) => tab.url.startsWith(prefix));
            });
            let targetTab = usable;
            if (!targetTab) {
              const fallback = await activeTabGateway.getActiveCapturableTab();
              if (fallback?.id) {
                targetTab = fallback;
              }
            }
            if (!targetTab?.id) {
              throw new Error("No shareable browser tab is open. Switch to a regular browser tab and try again.");
            }
            if (!chrome.tabCapture?.getMediaStreamId) {
              throw new Error("This Chrome build does not expose chrome.tabCapture. Update Chrome to use the silent capture flow.");
            }
            const targetTabId = targetTab.id;
            const streamId = await new Promise((resolve, reject) => {
              chrome.tabCapture.getMediaStreamId(
                { consumerTabId, targetTabId },
                (id) => {
                  const runtimeError = chrome.runtime.lastError;
                  if (runtimeError) {
                    reject(new Error(runtimeError.message));
                    return;
                  }
                  if (!id) {
                    reject(new Error("chrome.tabCapture returned an empty stream id."));
                    return;
                  }
                  resolve(id);
                }
              );
            });
            latestScreenShareOverlayTabId = targetTabId;
            sendResponse({
              ok: true,
              streamId,
              targetTabId,
              sourceLabel: targetTab.title || targetTab.url || "Browser tab"
            });
          } catch (error) {
            const messageText = error instanceof Error ? error.message : "Tab capture stream id lookup failed.";
            debugError("background", "Tab capture stream id lookup failed.", messageText);
            sendResponse({ ok: false, message: messageText });
          }
        })();
        return true;
      }
      if (message?.type === "screen-share-viewer-status") {
        latestScreenShareStatus = screenShareGateway.updateStatus({
          state: message.status?.state === "idle" || message.status?.state === "launching" || message.status?.state === "active" || message.status?.state === "ended" || message.status?.state === "error" ? message.status.state : "error",
          active: Boolean(message.status?.active),
          viewerWindowId: typeof message.status?.viewerWindowId === "number" ? message.status.viewerWindowId : latestScreenShareStatus.viewerWindowId,
          sourceLabel: typeof message.status?.sourceLabel === "string" ? message.status.sourceLabel : null,
          updatedAt: typeof message.status?.updatedAt === "string" ? message.status.updatedAt : (/* @__PURE__ */ new Date()).toISOString(),
          message: typeof message.status?.message === "string" ? message.status.message : "Screen share status updated."
        });
        void syncScreenShareClientControls(latestScreenShareStatus);
        notifyScreenShareStatusChanged(latestScreenShareStatus);
        sendResponse({ ok: true, status: latestScreenShareStatus });
        return true;
      }
      if (message?.type === "screen-share-stop-request") {
        void requestScreenShareStop().catch((error) => {
          debugError("background", "Screen share stop request from page failed.", error);
        });
        sendResponse({ ok: true, status: latestScreenShareStatus });
        return true;
      }
      return false;
    });
    function resolveStorageArea(area) {
      if (area === "sync" && chrome.storage?.sync) {
        return chrome.storage.sync;
      }
      if (chrome.storage?.local) {
        return chrome.storage.local;
      }
      throw new Error("No supported chrome.storage area is available in the background context.");
    }
    void ensureBridge();
  }
});
export default require_main();
//# sourceMappingURL=background.js.map
