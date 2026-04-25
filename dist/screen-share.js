var __getOwnPropNames = Object.getOwnPropertyNames;
var __commonJS = (cb, mod) => function __require() {
  return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
};

// src/screen-share/index.ts
var require_screen_share = __commonJS({
  "src/screen-share/index.ts"() {
    var previewElement = document.querySelector("#preview");
    var statusElement = document.querySelector("#status");
    var startButton = document.querySelector("#start-button");
    var stopButton = document.querySelector("#stop-button");
    var activeStream = null;
    var isStarting = false;
    var framePumpTimer = null;
    var frameSequence = 0;
    var frameEncodeInFlight = false;
    var streamSocket = null;
    var streamSocketReady = null;
    var streamCanvas = document.createElement("canvas");
    var webpSupportProbe = 0;
    var lastFrameHash = 0;
    var lastFrameSentAtMs = 0;
    var FRAME_HEARTBEAT_MS = 5e3;
    async function initialize() {
      if (!previewElement || !statusElement || !stopButton || !startButton) {
        return;
      }
      const handleStart = () => {
        void beginStartFlow();
      };
      startButton.addEventListener("click", handleStart);
      stopButton.addEventListener("click", () => {
        stopShare("Screen streaming stopped from the browser prompt.");
        window.close();
      });
      window.addEventListener("beforeunload", () => {
        stopShare("Screen share window is closing.");
      });
      chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
        if (message?.type !== "screen-share-force-stop") {
          return false;
        }
        stopShare("Screen sharing stopped from the client page.");
        window.close();
        sendResponse({ ok: true });
        return true;
      });
      const response = await chrome.runtime.sendMessage({ type: "screen-share-viewer-ready" });
      if (!response?.ok) {
        renderStatus(response?.message ?? response?.status?.message ?? "No pending screen share session is available.");
        return;
      }
      renderStatus(response?.status?.message ?? "Browser prompt is ready. Click Start Streaming to open the picker.");
      syncControls();
    }
    async function beginStartFlow() {
      if (isStarting || activeStream) {
        return;
      }
      isStarting = true;
      syncControls();
      renderStatus("Opening the Chrome screen picker...");
      try {
        const stream = await navigator.mediaDevices.getDisplayMedia({
          audio: false,
          video: {
            frameRate: { ideal: 30, max: 30 },
            width: { ideal: 1920 },
            height: { ideal: 1080 },
            displaySurface: "browser"
          },
          // Hide the operator's own viewer popup from the picker, and let them switch tabs mid-share.
          selfBrowserSurface: "exclude",
          surfaceSwitching: "include",
          monitorTypeSurfaces: "exclude"
        });
        const [videoTrackForCheck] = stream.getVideoTracks();
        const surface = videoTrackForCheck?.getSettings().displaySurface;
        if (surface && surface !== "browser") {
          stream.getTracks().forEach((track) => track.stop());
          throw new Error(
            "This share captures more than a browser tab, which the extension cannot click on. Pick a Chrome tab in the picker, or run the native client agent for full-desktop control."
          );
        }
        activeStream = stream;
        if (previewElement) {
          previewElement.srcObject = stream;
        }
        const [videoTrack] = stream.getVideoTracks();
        videoTrack?.addEventListener("ended", () => {
          stopShare("The user ended screen sharing.");
        });
        await ensureStreamSocket();
        startFramePump();
        await chrome.runtime.sendMessage({
          type: "screen-share-viewer-status",
          status: {
            state: "active",
            active: true,
            sourceLabel: videoTrack?.label || "Screen share",
            updatedAt: (/* @__PURE__ */ new Date()).toISOString(),
            message: "Screen stream is active. Live frames are being sent to the Python desktop app."
          }
        });
        await minimizeCurrentWindow();
        renderStatus("Streaming to the Python desktop app. Use the Stop Sharing button on the client page to end the session.");
      } catch (error) {
        const message = toShareErrorMessage(error);
        await chrome.runtime.sendMessage({
          type: "screen-share-viewer-status",
          status: {
            state: "error",
            active: false,
            sourceLabel: null,
            updatedAt: (/* @__PURE__ */ new Date()).toISOString(),
            message
          }
        });
        renderStatus(message);
      } finally {
        isStarting = false;
        syncControls();
      }
    }
    function stopShare(message) {
      stopFramePump();
      closeStreamSocket();
      if (activeStream) {
        for (const track of activeStream.getTracks()) {
          track.stop();
        }
        activeStream = null;
      }
      if (previewElement) {
        previewElement.srcObject = null;
      }
      renderStatus(message);
      syncControls();
      void chrome.runtime.sendMessage({
        type: "screen-share-viewer-status",
        status: {
          state: "ended",
          active: false,
          sourceLabel: null,
          updatedAt: (/* @__PURE__ */ new Date()).toISOString(),
          message
        }
      }).catch(() => void 0);
    }
    function renderStatus(message) {
      if (statusElement) {
        statusElement.textContent = message;
      }
    }
    function syncControls() {
      if (!startButton || !stopButton) {
        return;
      }
      const canStart = !isStarting && !activeStream;
      startButton.disabled = !canStart;
      stopButton.disabled = !activeStream && !isStarting;
    }
    async function ensureStreamSocket() {
      if (streamSocket && streamSocket.readyState === WebSocket.OPEN) {
        return;
      }
      if (streamSocketReady) {
        return streamSocketReady;
      }
      streamSocketReady = (async () => {
        const response = await chrome.runtime.sendMessage({ type: "screen-share-stream-endpoint-get" });
        if (!response?.ok || !response.targetUrl) {
          throw new Error(response?.message ?? "No websocket target is available for screen share streaming.");
        }
        await openStreamSocket(response.targetUrl);
      })();
      try {
        await streamSocketReady;
      } finally {
        streamSocketReady = null;
      }
    }
    async function openStreamSocket(targetUrl) {
      await new Promise((resolve, reject) => {
        const socket = new WebSocket(targetUrl);
        let settled = false;
        const finalizeFailure = (error) => {
          if (settled) {
            return;
          }
          settled = true;
          streamSocket = null;
          reject(error);
        };
        socket.addEventListener("open", () => {
          if (settled) {
            return;
          }
          settled = true;
          streamSocket = socket;
          socket.send(
            JSON.stringify({
              type: "screen-share.stream-register",
              clientId: crypto.randomUUID(),
              name: "screen-share-viewer",
              version: "1.0.0"
            })
          );
          resolve();
        });
        socket.addEventListener("error", () => {
          finalizeFailure(new Error("Unable to connect the screen share stream to the desktop bridge."));
        });
        socket.addEventListener("close", () => {
          if (!settled) {
            finalizeFailure(new Error("The screen share stream connection closed before it was ready."));
            return;
          }
          if (streamSocket === socket) {
            streamSocket = null;
          }
        });
      });
    }
    function closeStreamSocket() {
      if (!streamSocket) {
        return;
      }
      const socket = streamSocket;
      streamSocket = null;
      try {
        socket.close(1e3, "Screen share stopped");
      } catch {
      }
    }
    function startFramePump() {
      stopFramePump();
      frameSequence = 0;
      frameEncodeInFlight = false;
      lastFrameHash = 0;
      lastFrameSentAtMs = 0;
      framePumpTimer = window.setInterval(() => {
        void pushNextFrame();
      }, 80);
    }
    function stopFramePump() {
      if (framePumpTimer !== null) {
        window.clearInterval(framePumpTimer);
        framePumpTimer = null;
      }
      frameEncodeInFlight = false;
    }
    async function pushNextFrame() {
      if (frameEncodeInFlight || !activeStream || !previewElement || !streamSocket || streamSocket.readyState !== WebSocket.OPEN) {
        return;
      }
      const sourceWidth = previewElement.videoWidth;
      const sourceHeight = previewElement.videoHeight;
      if (!sourceWidth || !sourceHeight) {
        return;
      }
      frameEncodeInFlight = true;
      try {
        const maxWidth = 1280;
        const scale = Math.min(1, maxWidth / sourceWidth);
        const frameWidth = Math.max(1, Math.round(sourceWidth * scale));
        const frameHeight = Math.max(1, Math.round(sourceHeight * scale));
        streamCanvas.width = frameWidth;
        streamCanvas.height = frameHeight;
        const context = streamCanvas.getContext("2d", { alpha: false });
        if (!context) {
          return;
        }
        context.drawImage(previewElement, 0, 0, frameWidth, frameHeight);
        const encoded = await encodeFrame(streamCanvas);
        if (!encoded) {
          return;
        }
        const imageBytes = new Uint8Array(await encoded.blob.arrayBuffer());
        const frameHash = computeFrameHash(imageBytes);
        const nowMs = performance.now();
        const isDuplicate = frameHash === lastFrameHash;
        const heartbeatDue = nowMs - lastFrameSentAtMs >= FRAME_HEARTBEAT_MS;
        if (isDuplicate && !heartbeatDue) {
          return;
        }
        const videoTrack = activeStream?.getVideoTracks?.()[0];
        const surfaceLabel = videoTrack?.label || "Screen share";
        const metadataBytes = new TextEncoder().encode(
          JSON.stringify({
            type: "screen-share.frame.binary",
            mimeType: encoded.mimeType,
            capturedAt: (/* @__PURE__ */ new Date()).toISOString(),
            width: frameWidth,
            height: frameHeight,
            surfaceWidth: sourceWidth,
            surfaceHeight: sourceHeight,
            surfaceLabel,
            sequence: frameSequence,
            duplicate: isDuplicate
          })
        );
        frameSequence += 1;
        const envelope = new Uint8Array(4 + metadataBytes.length + imageBytes.length);
        const view = new DataView(envelope.buffer);
        view.setUint32(0, metadataBytes.length);
        envelope.set(metadataBytes, 4);
        envelope.set(imageBytes, 4 + metadataBytes.length);
        streamSocket.send(envelope.buffer);
        lastFrameHash = frameHash;
        lastFrameSentAtMs = nowMs;
      } finally {
        frameEncodeInFlight = false;
      }
    }
    async function encodeFrame(canvas) {
      if (webpSupportProbe >= 0) {
        const webpBlob = await new Promise((resolve) => {
          try {
            canvas.toBlob(resolve, "image/webp", 0.78);
          } catch {
            resolve(null);
          }
        });
        if (webpBlob && webpBlob.type === "image/webp") {
          webpSupportProbe = 1;
          return { blob: webpBlob, mimeType: "image/webp" };
        }
        webpSupportProbe = -1;
      }
      const jpegBlob = await new Promise((resolve) => {
        canvas.toBlob(resolve, "image/jpeg", 0.72);
      });
      if (!jpegBlob) {
        return null;
      }
      return { blob: jpegBlob, mimeType: "image/jpeg" };
    }
    function computeFrameHash(bytes) {
      let hash = 2166136261;
      const length = bytes.length;
      if (length === 0) {
        return hash >>> 0;
      }
      hash = Math.imul(hash ^ length, 16777619);
      const stride = Math.max(1, Math.floor(length / 512));
      for (let i = 0; i < length; i += stride) {
        hash = Math.imul(hash ^ bytes[i], 16777619);
      }
      hash = Math.imul(hash ^ bytes[length - 1], 16777619);
      return hash >>> 0;
    }
    function toShareErrorMessage(error) {
      if (error instanceof DOMException) {
        if (error.name === "NotAllowedError") {
          return "Screen share was not started. Click Start Sharing in Chrome and approve the picker to continue.";
        }
        if (error.name === "NotFoundError") {
          return "No shareable display source was returned by the browser.";
        }
        if (error.name === "NotReadableError") {
          return "Chrome could not start reading the selected display source.";
        }
        if (error.name === "AbortError") {
          return "Screen share was interrupted before the preview started.";
        }
      }
      if (error instanceof Error && error.message) {
        return error.message;
      }
      return "Unable to start the screen share preview.";
    }
    async function minimizeCurrentWindow() {
      if (!chrome.windows?.getCurrent || !chrome.windows?.update) {
        return;
      }
      try {
        const currentWindow = await chrome.windows.getCurrent();
        if (typeof currentWindow.id !== "number") {
          return;
        }
        await chrome.windows.update(currentWindow.id, {
          state: "minimized"
        });
      } catch {
      }
    }
    void initialize();
  }
});
export default require_screen_share();
//# sourceMappingURL=screen-share.js.map
