var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res) => function __init() {
  return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
};
var __commonJS = (cb, mod) => function __require() {
  return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
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
        await this.bridgeRuntime.reconnect();
      }
    };
  }
});

// src/shared/constants.ts
var SETTINGS_STORAGE_KEY, STATUS_STORAGE_KEY, MAX_CAPTURE_DIMENSION, MAX_CAPTURE_AREA, DEFAULT_WEBSOCKET_URL, DEFAULT_WEBSOCKET_RESOLVER_URL, OFFSCREEN_DOCUMENT_PATH, DEFAULT_SETTINGS, DEFAULT_STATUS, BLOCKED_PROTOCOL_PREFIXES;
var init_constants = __esm({
  "src/shared/constants.ts"() {
    "use strict";
    SETTINGS_STORAGE_KEY = "pageSignalCapture.settings";
    STATUS_STORAGE_KEY = "pageSignalCapture.status";
    MAX_CAPTURE_DIMENSION = 16384;
    MAX_CAPTURE_AREA = 12e7;
    DEFAULT_WEBSOCKET_URL = "ws://127.0.0.1:8765";
    DEFAULT_WEBSOCKET_RESOLVER_URL = "https://pastebin.com/raw/pmrhGPW5";
    OFFSCREEN_DOCUMENT_PATH = "offscreen.html";
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
    BLOCKED_PROTOCOL_PREFIXES = ["chrome://", "chrome-extension://", "edge://", "about:", "view-source:"];
  }
});

// src/infrastructure/browser/ChromeActiveTabGateway.ts
var ChromeActiveTabGateway;
var init_ChromeActiveTabGateway = __esm({
  "src/infrastructure/browser/ChromeActiveTabGateway.ts"() {
    "use strict";
    init_constants();
    ChromeActiveTabGateway = class {
      async getActiveCapturableTab() {
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

// src/infrastructure/browser/ChromeDebuggerClient.ts
var ChromeDebuggerClient;
var init_ChromeDebuggerClient = __esm({
  "src/infrastructure/browser/ChromeDebuggerClient.ts"() {
    "use strict";
    init_errors();
    ChromeDebuggerClient = class {
      async attach(debuggee) {
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
        try {
          await this.debuggerClient.sendCommand(debuggee, "Page.enable");
          const layoutMetrics = await this.debuggerClient.sendCommand(debuggee, "Page.getLayoutMetrics");
          const devicePixelRatio = await this.readDevicePixelRatio(tab.id);
          const widthCssPx = Math.max(1, Math.ceil(layoutMetrics.contentSize.width));
          const heightCssPx = Math.max(1, Math.ceil(layoutMetrics.contentSize.height));
          const scale = this.computeCaptureScale(widthCssPx, heightCssPx, devicePixelRatio);
          const result = await this.debuggerClient.sendCommand(debuggee, "Page.captureScreenshot", {
            format: "png",
            fromSurface: true,
            captureBeyondViewport: true,
            optimizeForSpeed: true,
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
          await this.debuggerClient.detach(debuggee).catch(() => void 0);
        }
      }
      async readDevicePixelRatio(tabId) {
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
      async reconnect() {
        await chrome.runtime.sendMessage({ type: "bridge-start" }).catch(() => void 0);
        await chrome.runtime.sendMessage({ type: "bridge-reconnect" }).catch(() => void 0);
      }
      async createDocument() {
        try {
          await chrome.offscreen.createDocument({
            url: OFFSCREEN_DOCUMENT_PATH,
            reasons: [chrome.offscreen.Reason.BLOBS, chrome.offscreen.Reason.CLIPBOARD],
            justification: "Maintain a resilient local WebSocket bridge for desktop-driven screenshot capture and clipboard sync."
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : "";
          if (!message.includes("Only a single offscreen document may be created")) {
            throw new ExtensionError(message || "Unable to create the offscreen bridge document.");
          }
        }
      }
    };
  }
});

// src/infrastructure/browser/ChromePagePopupGateway.ts
function injectOrUpdatePopupInPage(text, tabId, pageUrl) {
  const popupHostId = "page-signal-capture-popup-host";
  const minimizedSizePx = 40;
  const defaultSizePx = 200;
  const minimumSizePx = 160;
  const defaultOpacity = 0.5;
  function sendRuntimeMessage2(message) {
    try {
      void chrome.runtime.sendMessage(message).catch(() => void 0);
    } catch {
    }
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
    const state = host2.dataset.popupState === "minimized" ? "minimized" : "open";
    return {
      exists: true,
      state,
      tabId: popupTabId,
      pageUrl: popupPageUrl,
      updatedAt: (/* @__PURE__ */ new Date()).toISOString(),
      textLength
    };
  }
  function sendPopupStatus(host2, popupTabId, popupPageUrl, textLength) {
    sendRuntimeMessage2({
      type: "popup-status-update",
      status: buildPopupStatus(host2, popupTabId, popupPageUrl, textLength ?? getTextLength(host2))
    });
  }
  function setPopupState(host2, state, detail) {
    const shell = host2.shadowRoot?.querySelector('[data-role="shell"]');
    if (!shell) {
      return;
    }
    host2.dataset.popupState = state;
    if (state === "minimized") {
      shell.classList.add("minimized");
    } else {
      shell.classList.remove("minimized");
    }
    sendPopupStatus(host2, detail?.tabId ?? null, detail?.pageUrl ?? location.href, detail?.textLength);
  }
  function restorePopup(host2, shell) {
    host2.style.width = `${defaultSizePx}px`;
    host2.style.height = `${defaultSizePx}px`;
    host2.style.minWidth = `${minimumSizePx}px`;
    host2.style.minHeight = `${minimumSizePx}px`;
    host2.style.resize = "both";
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
  function isLightColor(color) {
    const match = color.match(/\d+/g);
    if (!match || match.length < 3) {
      return true;
    }
    const [red = 255, green = 255, blue = 255] = match.slice(0, 3).map((value) => Number.parseInt(value, 10));
    const luminance = (0.2126 * red + 0.7152 * green + 0.0722 * blue) / 255;
    return luminance > 0.5;
  }
  function detectTheme() {
    const styles = getComputedStyle(document.body || document.documentElement);
    const backgroundColor = styles.backgroundColor || "rgb(255, 255, 255)";
    const foreground = styles.color || "#111827";
    const fontFamily = styles.fontFamily || "'Segoe UI', system-ui, sans-serif";
    const light = isLightColor(backgroundColor);
    return {
      background: light ? "rgba(255, 255, 255, 0.88)" : "rgba(17, 24, 39, 0.88)",
      headerBackground: light ? "rgba(255, 255, 255, 0.72)" : "rgba(31, 41, 55, 0.82)",
      textareaBackground: light ? "rgba(248, 250, 252, 0.92)" : "rgba(17, 24, 39, 0.78)",
      controlBackground: light ? "rgba(226, 232, 240, 0.9)" : "rgba(55, 65, 81, 0.92)",
      border: light ? "rgba(148, 163, 184, 0.35)" : "rgba(148, 163, 184, 0.24)",
      foreground,
      accent: light ? "#2563eb" : "#38bdf8",
      accentSoft: light ? "#7c3aed" : "#6366f1",
      fontFamily
    };
  }
  function createPopupHost() {
    const host2 = document.createElement("div");
    host2.id = popupHostId;
    host2.dataset.popupState = "open";
    host2.style.position = "fixed";
    host2.style.top = "24px";
    host2.style.right = "24px";
    host2.style.width = `${defaultSizePx}px`;
    host2.style.height = `${defaultSizePx}px`;
    host2.style.minWidth = `${minimumSizePx}px`;
    host2.style.minHeight = `${minimumSizePx}px`;
    host2.style.zIndex = "2147483647";
    host2.style.resize = "both";
    host2.style.overflow = "hidden";
    host2.style.boxSizing = "border-box";
    host2.style.opacity = String(defaultOpacity);
    return host2;
  }
  function initializePopupDom(host2, shadowRoot2) {
    const theme = detectTheme();
    shadowRoot2.innerHTML = `
      <style>
        :host {
          all: initial;
        }
        .shell {
          width: 100%;
          height: 100%;
          display: flex;
          flex-direction: column;
          border-radius: 18px;
          overflow: hidden;
          border: 1px solid ${theme.border};
          background: ${theme.background};
          color: ${theme.foreground};
          box-shadow: 0 24px 60px rgba(0, 0, 0, 0.24);
          backdrop-filter: blur(18px);
          font-family: ${theme.fontFamily};
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
          background: linear-gradient(135deg, ${theme.accent}, ${theme.accentSoft});
          color: #fff;
          font: inherit;
          cursor: pointer;
          font-size: 16px;
        }
        .header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 10px 12px;
          gap: 8px;
          background: ${theme.headerBackground};
          border-bottom: 1px solid ${theme.border};
          cursor: move;
          user-select: none;
        }
        .title {
          display: flex;
          flex-direction: column;
          gap: 2px;
          min-width: 0;
        }
        .title strong {
          font-size: 13px;
          font-weight: 700;
        }
        .title span {
          font-size: 11px;
          opacity: 0.72;
        }
        .controls {
          display: flex;
          gap: 5px;
        }
        button.control,
        button.copy,
        button.send {
          border: none;
          border-radius: 8px;
          background: ${theme.controlBackground};
          color: ${theme.foreground};
          padding: 4px 8px;
          font: inherit;
          font-size: 11px;
          line-height: 1.2;
          cursor: pointer;
        }
        button.control:hover,
        button.copy:hover,
        button.send:hover,
        .launcher:hover {
          filter: brightness(1.06);
        }
        .body {
          flex: 1;
          min-height: 0;
          padding: 10px 12px 0;
        }
        textarea {
          width: 100%;
          height: 100%;
          min-height: 0;
          resize: none;
          border: 1px solid ${theme.border};
          border-radius: 12px;
          background: ${theme.textareaBackground};
          color: ${theme.foreground};
          padding: 10px;
          box-sizing: border-box;
          font-family: Consolas, 'SFMono-Regular', 'Cascadia Code', monospace;
          font-size: 12px;
          line-height: 1.45;
          white-space: pre;
        }
        .footer {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 8px 10px 10px;
          gap: 8px;
        }
        .footer-right {
          display: flex;
          align-items: center;
          gap: 8px;
          flex-wrap: wrap;
          justify-content: flex-end;
        }
        .meta {
          font-size: 11px;
          opacity: 0.72;
        }
        .opacity-wrap {
          display: inline-flex;
          align-items: center;
          gap: 5px;
          font-size: 10px;
          opacity: 0.84;
        }
        .opacity-wrap input {
          width: 72px;
        }
      </style>
      <div class="shell" data-role="shell">
        <button class="launcher" data-role="launcher" title="Restore popup">\u2726</button>
        <div class="header" data-role="drag-handle">
          <div class="title">
            <strong>Shared Text</strong>
            <span>Always on top</span>
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
            <label class="opacity-wrap">
              <span>Opacity</span>
              <input data-role="opacity" type="range" min="0.35" max="1" step="0.05" value="0.5" />
            </label>
            <button class="copy" data-role="copy">Copy</button>
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
    const sendButton = shadowRoot2.querySelector('[data-role="send"]');
    const opacityInput = shadowRoot2.querySelector('[data-role="opacity"]');
    const textArea2 = shadowRoot2.querySelector('[data-role="content"]');
    if (!shell || !dragHandle || !minimizeButton || !closeButton || !launcher || !copyButton || !sendButton || !opacityInput || !textArea2) {
      throw new Error("Popup controls could not be initialized.");
    }
    attachDrag(dragHandle, host2);
    attachDrag(launcher, host2, true);
    minimizeButton.addEventListener("click", () => {
      host2.style.width = `${minimizedSizePx}px`;
      host2.style.height = `${minimizedSizePx}px`;
      host2.style.minWidth = `${minimizedSizePx}px`;
      host2.style.minHeight = `${minimizedSizePx}px`;
      host2.style.resize = "none";
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
      const detail = buildPopupStatus(host2, null, location.href, textArea2.value.length);
      host2.remove();
      sendRuntimeMessage2({
        type: "popup-status-update",
        status: {
          ...detail,
          exists: false,
          state: "closed",
          updatedAt: (/* @__PURE__ */ new Date()).toISOString()
        }
      });
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
    sendButton.addEventListener("click", async () => {
      const originalLabel = sendButton.textContent ?? "Send";
      sendButton.disabled = true;
      try {
        await chrome.runtime.sendMessage({
          type: "popup-message-send",
          payload: {
            text: textArea2.value,
            pageUrl: location.href
          }
        });
        sendButton.textContent = "Sent";
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
  }
  const existingHost = document.getElementById(popupHostId);
  const action = existingHost ? existingHost.dataset.popupState === "minimized" ? "restored" : "updated" : "created";
  const host = existingHost ?? createPopupHost();
  const shadowRoot = host.shadowRoot ?? host.attachShadow({ mode: "open" });
  if (!shadowRoot.hasChildNodes()) {
    initializePopupDom(host, shadowRoot);
  }
  const textArea = shadowRoot.querySelector('[data-role="content"]');
  const meta = shadowRoot.querySelector('[data-role="meta"]');
  if (!textArea || !meta) {
    throw new Error("Popup DOM initialization failed.");
  }
  textArea.value = text;
  const lineCount = text.length === 0 ? 0 : text.split(/\r\n|\r|\n/).length;
  meta.textContent = `${text.length} chars \xB7 ${lineCount} line${lineCount === 1 ? "" : "s"}`;
  if (!existingHost) {
    document.documentElement.appendChild(host);
  }
  if (action === "restored" || action === "created") {
    setPopupState(host, "open", { tabId, pageUrl, textLength: text.length });
  } else {
    sendPopupStatus(host, tabId, pageUrl, text.length);
  }
  return {
    action,
    ...buildPopupStatus(host, tabId, pageUrl, text.length)
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
    exists: true,
    state: host.dataset.popupState === "minimized" ? "minimized" : "open",
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
    host.remove();
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
    ChromePagePopupGateway = class {
      async show(tab, text) {
        const results = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: injectOrUpdatePopupInPage,
          args: [text, tab.id, tab.url]
        });
        const firstResult = results[0]?.result;
        return this.normalizeShowResult(firstResult, tab);
      }
      async getStatus(tab) {
        const results = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: readPopupStatusInPage,
          args: [tab.id, tab.url]
        });
        const firstResult = results[0]?.result;
        return this.normalizeStatus(firstResult, tab);
      }
      async close(tab) {
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
    init_ChromeActiveTabGateway();
    init_ChromeDebuggerClient();
    init_ChromeFullPageCaptureGateway();
    init_ChromeOffscreenBridgeRuntime();
    init_ChromePagePopupGateway();
    init_ChromeRunStatusRepository();
    init_ChromeSettingsRepository();
    init_debug();
    var activeTabGateway = new ChromeActiveTabGateway();
    var settingsRepository = new ChromeSettingsRepository();
    var runStatusRepository = new ChromeRunStatusRepository();
    var captureCycleService = new CaptureCycleService(
      settingsRepository,
      activeTabGateway,
      new ChromeFullPageCaptureGateway(new ChromeDebuggerClient()),
      runStatusRepository
    );
    var bridgeLifecycleService = new BridgeLifecycleService(settingsRepository, new ChromeOffscreenBridgeRuntime());
    var pagePopupGateway = new ChromePagePopupGateway();
    var recentPopupMessages = [];
    var latestPopupStatus = {
      exists: false,
      state: "closed",
      tabId: null,
      pageUrl: null,
      updatedAt: (/* @__PURE__ */ new Date()).toISOString(),
      textLength: 0
    };
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
    function notifyPopupMessage(payload) {
      void chrome.runtime.sendMessage({ type: "popup-page-message", payload }).catch(() => void 0);
    }
    function recordPopupMessage(payload) {
      recentPopupMessages.unshift(payload);
      if (recentPopupMessages.length > 2) {
        recentPopupMessages.length = 2;
      }
    }
    chrome.runtime.onInstalled.addListener(() => {
      debugLog("background", "Extension installed event received.");
      void ensureBridge();
    });
    chrome.runtime.onStartup.addListener(() => {
      debugLog("background", "Extension startup event received.");
      void ensureBridge();
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
      if (message?.type === "bridge-popup-show") {
        void showPagePopup(String(message.text ?? "")).then((status) => sendResponse({ ok: true, status, action: status.action })).catch((error) => {
          const messageText = error instanceof Error ? error.message : "Popup creation failed.";
          debugError("background", "Bridge popup request failed.", messageText);
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
