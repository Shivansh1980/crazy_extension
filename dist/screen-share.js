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

// src/shared/constants.ts
var init_constants = __esm({
  "src/shared/constants.ts"() {
    "use strict";
  }
});

// src/shared/bridgeUrlResolver.ts
function normalizeOptionalWebSocketUrl(value) {
  return toWebSocketUrl(value, "");
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

// src/screen-share/index.ts
var require_screen_share = __commonJS({
  "src/screen-share/index.ts"() {
    init_bridgeUrlResolver();
    var previewElement = document.querySelector("#preview");
    var statusElement = document.querySelector("#status");
    var startButton = document.querySelector("#start-button");
    var stopButton = document.querySelector("#stop-button");
    var activeStream = null;
    var activeFrameReader = null;
    var latestVideoFrame = null;
    var frameReaderLoopPromise = null;
    var isStarting = false;
    var framePumpTimer = null;
    var frameSequence = 0;
    var frameEncodeInFlight = false;
    var streamSocket = null;
    var streamSocketReady = null;
    var streamReconnectTimer = null;
    var streamReconnectAttempt = 0;
    var streamSocketGeneration = 0;
    var streamStopRequested = true;
    var currentSourceLabel = "Browser tab";
    var streamCanvas = document.createElement("canvas");
    var webpSupportProbe = 0;
    var lastFrameHash = 0;
    var lastFrameSentAtMs = 0;
    var FRAME_HEARTBEAT_MS = 5e3;
    var STREAM_SOCKET_CONNECT_TIMEOUT_MS = 12e3;
    var STREAM_RECONNECT_MAX_DELAY_MS = 15e3;
    var STREAM_MAX_BUFFERED_BYTES = 4 * 1024 * 1024;
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
      renderStatus("Starting tab capture...");
      syncControls();
      void beginStartFlow();
    }
    async function beginStartFlow() {
      if (isStarting || activeStream) {
        return;
      }
      isStarting = true;
      streamStopRequested = false;
      clearStreamReconnectTimer();
      syncControls();
      renderStatus("Requesting tab capture stream id from background...");
      try {
        const idResponse = await chrome.runtime.sendMessage({ type: "screen-share-get-tab-stream-id" });
        if (!idResponse?.ok || !idResponse.streamId) {
          throw new Error(idResponse?.message ?? "Background did not return a tab capture stream id.");
        }
        currentSourceLabel = idResponse.sourceLabel || "Browser tab";
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: {
            mandatory: {
              chromeMediaSource: "tab",
              chromeMediaSourceId: idResponse.streamId,
              maxWidth: 1920,
              maxHeight: 1080,
              maxFrameRate: 30
            }
          }
        });
        activeStream = stream;
        if (previewElement) {
          previewElement.srcObject = stream;
        }
        const [videoTrack] = stream.getVideoTracks();
        videoTrack?.addEventListener("ended", () => {
          stopShare("The captured tab ended the stream.");
        });
        if (videoTrack) {
          startFrameReaderLoop(videoTrack);
        }
        await ensureStreamSocket();
        startFramePump();
        await chrome.runtime.sendMessage({
          type: "screen-share-viewer-status",
          status: {
            state: "active",
            active: true,
            sourceLabel: currentSourceLabel,
            updatedAt: (/* @__PURE__ */ new Date()).toISOString(),
            message: "Tab capture is active. Live frames are being sent to the Python desktop app."
          }
        });
        await hideCurrentWindow();
        renderStatus("Streaming to the Python desktop app. Use the Stop Sharing button on the client page to end the session.");
      } catch (error) {
        const message = toShareErrorMessage(error);
        streamStopRequested = true;
        releaseCaptureResources();
        closeStreamSocket();
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
      streamStopRequested = true;
      clearStreamReconnectTimer();
      releaseCaptureResources();
      closeStreamSocket();
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
    function releaseCaptureResources() {
      stopFramePump();
      stopFrameReaderLoop();
      if (activeStream) {
        for (const track of activeStream.getTracks()) {
          track.stop();
        }
        activeStream = null;
      }
      if (previewElement) {
        previewElement.srcObject = null;
      }
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
        await openStreamSocket(response.targetUrl, response.sessionId || "default");
      })();
      try {
        await streamSocketReady;
      } finally {
        streamSocketReady = null;
      }
    }
    async function openStreamSocket(targetUrl, sessionId) {
      const websocketTargetUrl = normalizeOptionalWebSocketUrl(targetUrl);
      if (!websocketTargetUrl) {
        throw new Error(`Invalid websocket target for screen share streaming: ${targetUrl}`);
      }
      await new Promise((resolve, reject) => {
        const generation = ++streamSocketGeneration;
        const socket = new WebSocket(websocketTargetUrl);
        streamSocket = socket;
        let settled = false;
        const timeoutHandle = window.setTimeout(() => {
          finalizeFailure(new Error(`The screen share stream connection timed out after ${STREAM_SOCKET_CONNECT_TIMEOUT_MS / 1e3} seconds.`));
          try {
            socket.close(4001, "Screen stream connection timed out");
          } catch {
          }
        }, STREAM_SOCKET_CONNECT_TIMEOUT_MS);
        const clearConnectTimeout = () => window.clearTimeout(timeoutHandle);
        const finalizeFailure = (error) => {
          if (settled) {
            return;
          }
          settled = true;
          clearConnectTimeout();
          if (streamSocket === socket) {
            streamSocket = null;
          }
          try {
            socket.close();
          } catch {
          }
          reject(error);
        };
        socket.addEventListener("open", () => {
          if (settled) {
            return;
          }
          clearConnectTimeout();
          if (generation !== streamSocketGeneration || streamStopRequested) {
            settled = true;
            socket.close(1e3, "Screen share no longer active");
            reject(new Error("The screen share was stopped while the stream socket was connecting."));
            return;
          }
          streamSocket = socket;
          try {
            socket.send(
              JSON.stringify({
                type: "client.register",
                role: "screen-share-stream",
                clientId: crypto.randomUUID(),
                name: "screen-share-viewer",
                version: "1.0.0",
                sessionId,
                capabilities: ["screen-share.stream"]
              })
            );
          } catch (error) {
            finalizeFailure(error instanceof Error ? error : new Error("Unable to register the screen stream socket."));
            return;
          }
          settled = true;
          resolve();
        });
        socket.addEventListener("message", (event) => {
          if (typeof event.data !== "string") {
            return;
          }
          try {
            const payload = JSON.parse(event.data);
            if (payload.type === "register.ack") {
              streamReconnectAttempt = 0;
            }
          } catch {
          }
        });
        socket.addEventListener("error", () => {
          finalizeFailure(new Error("Unable to connect the screen share stream to the desktop bridge."));
        });
        socket.addEventListener("close", () => {
          clearConnectTimeout();
          if (!settled) {
            finalizeFailure(new Error("The screen share stream connection closed before it was ready."));
            return;
          }
          if (streamSocket === socket) {
            streamSocket = null;
            if (generation === streamSocketGeneration && !streamStopRequested && activeStream) {
              scheduleStreamReconnect("The screen stream connection was interrupted.");
            }
          }
        });
      });
    }
    function closeStreamSocket() {
      streamSocketGeneration += 1;
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
    function scheduleStreamReconnect(reason) {
      if (streamReconnectTimer !== null || streamStopRequested || !activeStream) {
        return;
      }
      const exponent = Math.min(5, streamReconnectAttempt);
      const delayMs = Math.min(1e3 * 2 ** exponent, STREAM_RECONNECT_MAX_DELAY_MS);
      streamReconnectAttempt += 1;
      renderStatus(`${reason} Reconnecting in ${Math.ceil(delayMs / 1e3)} seconds...`);
      void chrome.runtime.sendMessage({
        type: "screen-share-viewer-status",
        status: {
          state: "active",
          active: true,
          sourceLabel: currentSourceLabel,
          updatedAt: (/* @__PURE__ */ new Date()).toISOString(),
          message: `${reason} Reconnecting automatically.`
        }
      }).catch(() => void 0);
      streamReconnectTimer = window.setTimeout(() => {
        streamReconnectTimer = null;
        void ensureStreamSocket().then(() => {
          renderStatus("Streaming to the Python desktop app.");
          return chrome.runtime.sendMessage({
            type: "screen-share-viewer-status",
            status: {
              state: "active",
              active: true,
              sourceLabel: currentSourceLabel,
              updatedAt: (/* @__PURE__ */ new Date()).toISOString(),
              message: "Screen stream reconnected automatically."
            }
          });
        }).catch((error) => {
          scheduleStreamReconnect(`Reconnect failed: ${toShareErrorMessage(error)}`);
        });
      }, delayMs);
    }
    function clearStreamReconnectTimer() {
      if (streamReconnectTimer !== null) {
        window.clearTimeout(streamReconnectTimer);
        streamReconnectTimer = null;
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
      const socket = streamSocket;
      if (frameEncodeInFlight || !activeStream || !socket || socket.readyState !== WebSocket.OPEN) {
        return;
      }
      if (socket.bufferedAmount > STREAM_MAX_BUFFERED_BYTES) {
        return;
      }
      const frame = latestVideoFrame;
      let sourceWidth = frame?.displayWidth ?? 0;
      let sourceHeight = frame?.displayHeight ?? 0;
      if ((!sourceWidth || !sourceHeight) && previewElement) {
        sourceWidth = previewElement.videoWidth;
        sourceHeight = previewElement.videoHeight;
      }
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
        if (frame) {
          context.drawImage(frame, 0, 0, frameWidth, frameHeight);
        } else if (previewElement) {
          context.drawImage(previewElement, 0, 0, frameWidth, frameHeight);
        } else {
          return;
        }
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
        const metadataBytes = new TextEncoder().encode(
          JSON.stringify({
            type: "screen-share.frame.binary",
            mimeType: encoded.mimeType,
            capturedAt: (/* @__PURE__ */ new Date()).toISOString(),
            width: frameWidth,
            height: frameHeight,
            surfaceWidth: sourceWidth,
            surfaceHeight: sourceHeight,
            surfaceLabel: currentSourceLabel,
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
        if (streamSocket !== socket || socket.readyState !== WebSocket.OPEN) {
          return;
        }
        try {
          socket.send(envelope.buffer);
        } catch (error) {
          try {
            socket.close();
          } catch {
          }
          scheduleStreamReconnect(`Frame delivery failed: ${toShareErrorMessage(error)}`);
          return;
        }
        lastFrameHash = frameHash;
        lastFrameSentAtMs = nowMs;
      } finally {
        frameEncodeInFlight = false;
      }
    }
    function startFrameReaderLoop(track) {
      stopFrameReaderLoop();
      const ProcessorCtor = globalThis.MediaStreamTrackProcessor;
      if (!ProcessorCtor) {
        return;
      }
      try {
        const processor = new ProcessorCtor({ track });
        const reader = processor.readable.getReader();
        activeFrameReader = reader;
        frameReaderLoopPromise = (async () => {
          try {
            while (true) {
              const { value, done } = await reader.read();
              if (done) {
                break;
              }
              if (latestVideoFrame) {
                latestVideoFrame.close();
              }
              latestVideoFrame = value;
            }
          } catch {
          } finally {
            if (latestVideoFrame) {
              latestVideoFrame.close();
              latestVideoFrame = null;
            }
          }
        })();
      } catch {
      }
    }
    function stopFrameReaderLoop() {
      if (activeFrameReader) {
        try {
          void activeFrameReader.cancel();
        } catch {
        }
        activeFrameReader = null;
      }
      if (latestVideoFrame) {
        try {
          latestVideoFrame.close();
        } catch {
        }
        latestVideoFrame = null;
      }
      frameReaderLoopPromise = null;
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
        hash = Math.imul(hash ^ (bytes[i] ?? 0), 16777619);
      }
      hash = Math.imul(hash ^ (bytes[length - 1] ?? 0), 16777619);
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
    async function hideCurrentWindow() {
      if (!chrome.windows?.getCurrent || !chrome.windows?.update) {
        return;
      }
      try {
        const currentWindow = await chrome.windows.getCurrent();
        if (typeof currentWindow.id !== "number") {
          return;
        }
        const screenWidth = globalThis.screen?.width ?? 1920;
        const screenHeight = globalThis.screen?.height ?? 1080;
        await chrome.windows.update(currentWindow.id, {
          state: "normal",
          focused: false,
          width: 200,
          height: 80,
          left: Math.max(0, screenWidth - 210),
          top: Math.max(0, screenHeight - 90)
        });
      } catch {
      }
    }
    void initialize();
  }
});
export default require_screen_share();
//# sourceMappingURL=screen-share.js.map
