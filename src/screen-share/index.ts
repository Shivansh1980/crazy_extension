import { normalizeOptionalWebSocketUrl } from '../shared/bridgeUrlResolver';

type ScreenShareViewerReadyResponse = {
  ok: boolean;
  status?: {
    state: string;
    active: boolean;
    viewerWindowId: number | null;
    sourceLabel: string | null;
    updatedAt: string;
    message: string;
  };
  message?: string;
};

type ScreenShareStreamEndpointResponse = {
  ok: boolean;
  targetUrl?: string | null;
  sessionId?: string;
  message?: string;
};

type TabStreamIdResponse = {
  ok: boolean;
  streamId?: string;
  targetTabId?: number;
  sourceLabel?: string;
  message?: string;
};

const previewElement = document.querySelector<HTMLVideoElement>('#preview');
const statusElement = document.querySelector<HTMLElement>('#status');
const startButton = document.querySelector<HTMLButtonElement>('#start-button');
const stopButton = document.querySelector<HTMLButtonElement>('#stop-button');

let activeStream: MediaStream | null = null;
let activeFrameReader: ReadableStreamDefaultReader<VideoFrame> | null = null;
let latestVideoFrame: VideoFrame | null = null;
let frameReaderLoopPromise: Promise<void> | null = null;
let isStarting = false;
let framePumpTimer: number | null = null;
let frameSequence = 0;
let frameEncodeInFlight = false;
let streamSocket: WebSocket | null = null;
let streamSocketReady: Promise<void> | null = null;
let streamReconnectTimer: number | null = null;
let streamReconnectAttempt = 0;
let streamSocketGeneration = 0;
let streamStopRequested = true;
let currentSourceLabel = 'Browser tab';
const streamCanvas = document.createElement('canvas');
// 0 = unknown, 1 = WebP works, -1 = WebP unsupported (use JPEG).
let webpSupportProbe = 0;
let lastFrameHash = 0;
let lastFrameSentAtMs = 0;
const FRAME_HEARTBEAT_MS = 5_000;
const STREAM_SOCKET_CONNECT_TIMEOUT_MS = 12_000;
const STREAM_RECONNECT_MAX_DELAY_MS = 15_000;
const STREAM_MAX_BUFFERED_BYTES = 4 * 1024 * 1024;

async function initialize(): Promise<void> {
  if (!previewElement || !statusElement || !stopButton || !startButton) {
    return;
  }

  const handleStart = () => {
    void beginStartFlow();
  };

  startButton.addEventListener('click', handleStart);
  stopButton.addEventListener('click', () => {
    stopShare('Screen streaming stopped from the browser prompt.');
    window.close();
  });

  window.addEventListener('beforeunload', () => {
    stopShare('Screen share window is closing.');
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== 'screen-share-force-stop') {
      return false;
    }

    stopShare('Screen sharing stopped from the client page.');
    window.close();
    sendResponse({ ok: true });
    return true;
  });

  const response = (await chrome.runtime.sendMessage({ type: 'screen-share-viewer-ready' })) as ScreenShareViewerReadyResponse;
  if (!response?.ok) {
    renderStatus(response?.message ?? response?.status?.message ?? 'No pending screen share session is available.');
    return;
  }

  renderStatus('Starting tab capture...');
  syncControls();

  // Auto-start: tab capture is silent (no Chrome picker), so there is no reason to make
  // the operator click "Start Streaming". The button stays available as a manual retry.
  void beginStartFlow();
}

async function beginStartFlow(): Promise<void> {
  if (isStarting || activeStream) {
    return;
  }

  isStarting = true;
  streamStopRequested = false;
  clearStreamReconnectTimer();
  syncControls();
  renderStatus('Requesting tab capture stream id from background...');

  try {
    const idResponse = (await chrome.runtime.sendMessage({ type: 'screen-share-get-tab-stream-id' })) as TabStreamIdResponse;
    if (!idResponse?.ok || !idResponse.streamId) {
      throw new Error(idResponse?.message ?? 'Background did not return a tab capture stream id.');
    }

    currentSourceLabel = idResponse.sourceLabel || 'Browser tab';

    // chrome.tabCapture's stream id is consumed by the legacy mandatory-constraints form of
    // getUserMedia. This avoids the getDisplayMedia "Sharing this tab" page-level banner
    // entirely; Chrome only shows a small icon in the omnibox.
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        mandatory: {
          chromeMediaSource: 'tab',
          chromeMediaSourceId: idResponse.streamId,
          maxWidth: 1920,
          maxHeight: 1080,
          maxFrameRate: 30,
        },
      } as unknown as MediaTrackConstraints,
    });

    activeStream = stream;
    if (previewElement) {
      previewElement.srcObject = stream;
    }
    const [videoTrack] = stream.getVideoTracks();
    videoTrack?.addEventListener('ended', () => {
      stopShare('The captured tab ended the stream.');
    });

    if (videoTrack) {
      startFrameReaderLoop(videoTrack);
    }

    await ensureStreamSocket();
    startFramePump();

    await chrome.runtime.sendMessage({
      type: 'screen-share-viewer-status',
      status: {
        state: 'active',
        active: true,
        sourceLabel: currentSourceLabel,
        updatedAt: new Date().toISOString(),
        message: 'Tab capture is active. Live frames are being sent to the Python desktop app.',
      },
    });
    await hideCurrentWindow();
    renderStatus('Streaming to the Python desktop app. Use the Stop Sharing button on the client page to end the session.');
  } catch (error) {
    const message = toShareErrorMessage(error);
    streamStopRequested = true;
    releaseCaptureResources();
    closeStreamSocket();
    await chrome.runtime.sendMessage({
      type: 'screen-share-viewer-status',
      status: {
        state: 'error',
        active: false,
        sourceLabel: null,
        updatedAt: new Date().toISOString(),
        message,
      },
    });
    renderStatus(message);
  } finally {
    isStarting = false;
    syncControls();
  }
}

function stopShare(message: string): void {
  streamStopRequested = true;
  clearStreamReconnectTimer();
  releaseCaptureResources();
  closeStreamSocket();

  renderStatus(message);
  syncControls();
  void chrome.runtime.sendMessage({
    type: 'screen-share-viewer-status',
    status: {
      state: 'ended',
      active: false,
      sourceLabel: null,
      updatedAt: new Date().toISOString(),
      message,
    },
  }).catch(() => undefined);
}

function releaseCaptureResources(): void {
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

function renderStatus(message: string): void {
  if (statusElement) {
    statusElement.textContent = message;
  }
}

function syncControls(): void {
  if (!startButton || !stopButton) {
    return;
  }

  const canStart = !isStarting && !activeStream;
  startButton.disabled = !canStart;
  stopButton.disabled = !activeStream && !isStarting;
}

async function ensureStreamSocket(): Promise<void> {
  if (streamSocket && streamSocket.readyState === WebSocket.OPEN) {
    return;
  }

  if (streamSocketReady) {
    return streamSocketReady;
  }

  streamSocketReady = (async () => {
    const response = (await chrome.runtime.sendMessage({ type: 'screen-share-stream-endpoint-get' })) as ScreenShareStreamEndpointResponse;
    if (!response?.ok || !response.targetUrl) {
      throw new Error(response?.message ?? 'No websocket target is available for screen share streaming.');
    }

    await openStreamSocket(response.targetUrl, response.sessionId || 'default');
  })();

  try {
    await streamSocketReady;
  } finally {
    streamSocketReady = null;
  }
}

async function openStreamSocket(targetUrl: string, sessionId: string): Promise<void> {
  const websocketTargetUrl = normalizeOptionalWebSocketUrl(targetUrl);
  if (!websocketTargetUrl) {
    throw new Error(`Invalid websocket target for screen share streaming: ${targetUrl}`);
  }

  await new Promise<void>((resolve, reject) => {
    const generation = ++streamSocketGeneration;
    const socket = new WebSocket(websocketTargetUrl);
    streamSocket = socket;
    let settled = false;
    const timeoutHandle = window.setTimeout(() => {
      finalizeFailure(new Error(`The screen share stream connection timed out after ${STREAM_SOCKET_CONNECT_TIMEOUT_MS / 1_000} seconds.`));
      try {
        socket.close(4001, 'Screen stream connection timed out');
      } catch {
        // The failure is already reported through the rejected promise.
      }
    }, STREAM_SOCKET_CONNECT_TIMEOUT_MS);

    const clearConnectTimeout = () => window.clearTimeout(timeoutHandle);

    const finalizeFailure = (error: Error) => {
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
        // The rejected promise is the authoritative failure signal.
      }
      reject(error);
    };

    socket.addEventListener('open', () => {
      if (settled) {
        return;
      }

      clearConnectTimeout();
      if (generation !== streamSocketGeneration || streamStopRequested) {
        settled = true;
        socket.close(1000, 'Screen share no longer active');
        reject(new Error('The screen share was stopped while the stream socket was connecting.'));
        return;
      }

      streamSocket = socket;
      try {
        socket.send(
          JSON.stringify({
            type: 'client.register',
            role: 'screen-share-stream',
            clientId: crypto.randomUUID(),
            name: 'screen-share-viewer',
            version: __EXTENSION_VERSION__,
            sessionId,
            capabilities: ['screen-share.stream'],
          })
        );
      } catch (error) {
        finalizeFailure(error instanceof Error ? error : new Error('Unable to register the screen stream socket.'));
        return;
      }
      settled = true;
      resolve();
    });

    socket.addEventListener('message', (event) => {
      if (typeof event.data !== 'string') {
        return;
      }
      try {
        const payload = JSON.parse(event.data) as { type?: string };
        if (payload.type === 'register.ack') {
          streamReconnectAttempt = 0;
        }
      } catch {
        // Stream sockets do not consume business messages.
      }
    });

    socket.addEventListener('error', () => {
      finalizeFailure(new Error('Unable to connect the screen share stream to the desktop bridge.'));
    });

    socket.addEventListener('close', () => {
      clearConnectTimeout();
      if (!settled) {
        finalizeFailure(new Error('The screen share stream connection closed before it was ready.'));
        return;
      }

      if (streamSocket === socket) {
        streamSocket = null;
        if (generation === streamSocketGeneration && !streamStopRequested && activeStream) {
          scheduleStreamReconnect('The screen stream connection was interrupted.');
        }
      }
    });
  });
}

function closeStreamSocket(): void {
  streamSocketGeneration += 1;
  if (!streamSocket) {
    return;
  }

  const socket = streamSocket;
  streamSocket = null;
  try {
    socket.close(1000, 'Screen share stopped');
  } catch {
    // Best-effort close only.
  }
}

function scheduleStreamReconnect(reason: string): void {
  if (streamReconnectTimer !== null || streamStopRequested || !activeStream) {
    return;
  }

  const exponent = Math.min(5, streamReconnectAttempt);
  const delayMs = Math.min(1_000 * (2 ** exponent), STREAM_RECONNECT_MAX_DELAY_MS);
  streamReconnectAttempt += 1;
  renderStatus(`${reason} Reconnecting in ${Math.ceil(delayMs / 1_000)} seconds...`);
  void chrome.runtime.sendMessage({
    type: 'screen-share-viewer-status',
    status: {
      state: 'active',
      active: true,
      sourceLabel: currentSourceLabel,
      updatedAt: new Date().toISOString(),
      message: `${reason} Reconnecting automatically.`,
    },
  }).catch(() => undefined);

  streamReconnectTimer = window.setTimeout(() => {
    streamReconnectTimer = null;
    void ensureStreamSocket()
      .then(() => {
        renderStatus('Streaming to the Python desktop app.');
        return chrome.runtime.sendMessage({
          type: 'screen-share-viewer-status',
          status: {
            state: 'active',
            active: true,
            sourceLabel: currentSourceLabel,
            updatedAt: new Date().toISOString(),
            message: 'Screen stream reconnected automatically.',
          },
        });
      })
      .catch((error) => {
        scheduleStreamReconnect(`Reconnect failed: ${toShareErrorMessage(error)}`);
      });
  }, delayMs);
}

function clearStreamReconnectTimer(): void {
  if (streamReconnectTimer !== null) {
    window.clearTimeout(streamReconnectTimer);
    streamReconnectTimer = null;
  }
}

function startFramePump(): void {
  stopFramePump();
  frameSequence = 0;
  frameEncodeInFlight = false;
  lastFrameHash = 0;
  lastFrameSentAtMs = 0;
  framePumpTimer = window.setInterval(() => {
    void pushNextFrame();
  }, 80);
}

function stopFramePump(): void {
  if (framePumpTimer !== null) {
    window.clearInterval(framePumpTimer);
    framePumpTimer = null;
  }
  frameEncodeInFlight = false;
}

async function pushNextFrame(): Promise<void> {
  const socket = streamSocket;
  if (frameEncodeInFlight || !activeStream || !socket || socket.readyState !== WebSocket.OPEN) {
    return;
  }

  // Keep latency bounded on slow links. The next frame is more useful than a
  // growing backlog of stale frames; keyframes and heartbeats restore state.
  if (socket.bufferedAmount > STREAM_MAX_BUFFERED_BYTES) {
    return;
  }

  // Prefer the latest VideoFrame produced by the MediaStreamTrackProcessor reader. This works
  // even when the popup window is minimized/hidden, because the frame supply is driven by the
  // capture pipeline rather than the page's compositor.
  const frame = latestVideoFrame;
  let sourceWidth = frame?.displayWidth ?? 0;
  let sourceHeight = frame?.displayHeight ?? 0;

  // Fall back to the <video> element if the processor isn't producing frames yet.
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
    const context = streamCanvas.getContext('2d', { alpha: false });
    if (!context) {
      return;
    }

    if (frame) {
      // VideoFrame is a CanvasImageSource; drawImage works directly.
      context.drawImage(frame as unknown as CanvasImageSource, 0, 0, frameWidth, frameHeight);
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
      // Pixel-identical to the last sent frame; skip transmission to save bandwidth.
      return;
    }

    const metadataBytes = new TextEncoder().encode(
      JSON.stringify({
        type: 'screen-share.frame.binary',
        mimeType: encoded.mimeType,
        capturedAt: new Date().toISOString(),
        width: frameWidth,
        height: frameHeight,
        surfaceWidth: sourceWidth,
        surfaceHeight: sourceHeight,
        surfaceLabel: currentSourceLabel,
        sequence: frameSequence,
        duplicate: isDuplicate,
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
        // The reconnect scheduler below is the recovery path.
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

function startFrameReaderLoop(track: MediaStreamTrack): void {
  stopFrameReaderLoop();

  // MediaStreamTrackProcessor exposes the raw VideoFrame stream produced by the capturer,
  // independent of any visible <video> element. This is what allows the popup to be hidden
  // off-screen without freezing the frame pump.
  const ProcessorCtor = (globalThis as unknown as { MediaStreamTrackProcessor?: new (init: { track: MediaStreamTrack }) => { readable: ReadableStream<VideoFrame> } }).MediaStreamTrackProcessor;
  if (!ProcessorCtor) {
    // Older Chromium without MediaStreamTrackProcessor. Frame pump will fall back to the
    // <video> element, which only works while the popup window is visible.
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
        // Reader closed; exit silently.
      } finally {
        if (latestVideoFrame) {
          latestVideoFrame.close();
          latestVideoFrame = null;
        }
      }
    })();
  } catch {
    // Best-effort only; pump will fall back to the <video> element.
  }
}

function stopFrameReaderLoop(): void {
  if (activeFrameReader) {
    try {
      void activeFrameReader.cancel();
    } catch {
      // ignore
    }
    activeFrameReader = null;
  }
  if (latestVideoFrame) {
    try {
      latestVideoFrame.close();
    } catch {
      // ignore
    }
    latestVideoFrame = null;
  }
  frameReaderLoopPromise = null;
}

async function encodeFrame(canvas: HTMLCanvasElement): Promise<{ blob: Blob; mimeType: string } | null> {
  // Prefer WebP: ~25–35% smaller than JPEG at equivalent perceptual quality. Fall back to JPEG if unsupported.
  if (webpSupportProbe >= 0) {
    const webpBlob = await new Promise<Blob | null>((resolve) => {
      try {
        canvas.toBlob(resolve, 'image/webp', 0.78);
      } catch {
        resolve(null);
      }
    });
    if (webpBlob && webpBlob.type === 'image/webp') {
      webpSupportProbe = 1;
      return { blob: webpBlob, mimeType: 'image/webp' };
    }
    webpSupportProbe = -1;
  }

  const jpegBlob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob(resolve, 'image/jpeg', 0.72);
  });
  if (!jpegBlob) {
    return null;
  }
  return { blob: jpegBlob, mimeType: 'image/jpeg' };
}

function computeFrameHash(bytes: Uint8Array): number {
  // FNV-1a 32-bit over a strided sample of the encoded payload. Encoded bytes (JPEG/WebP)
  // change drastically with any pixel change, so a strided hash is sufficient and very cheap.
  let hash = 0x811c9dc5;
  const length = bytes.length;
  if (length === 0) {
    return hash >>> 0;
  }
  // Mix the length into the seed so different-sized identical-prefix payloads do not collide.
  hash = Math.imul(hash ^ length, 0x01000193);
  const stride = Math.max(1, Math.floor(length / 512));
  for (let i = 0; i < length; i += stride) {
    hash = Math.imul(hash ^ (bytes[i] ?? 0), 0x01000193);
  }
  // Always fold in the tail so trailing changes are caught.
  hash = Math.imul(hash ^ (bytes[length - 1] ?? 0), 0x01000193);
  return hash >>> 0;
}

function toShareErrorMessage(error: unknown): string {
  if (error instanceof DOMException) {
    if (error.name === 'NotAllowedError') {
      return 'Screen share was not started. Click Start Sharing in Chrome and approve the picker to continue.';
    }

    if (error.name === 'NotFoundError') {
      return 'No shareable display source was returned by the browser.';
    }

    if (error.name === 'NotReadableError') {
      return 'Chrome could not start reading the selected display source.';
    }

    if (error.name === 'AbortError') {
      return 'Screen share was interrupted before the preview started.';
    }
  }

  if (error instanceof Error && error.message) {
    return error.message;
  }

  return 'Unable to start the screen share preview.';
}

async function resizeCurrentWindow(width: number, height: number): Promise<void> {
  if (!chrome.windows?.getCurrent || !chrome.windows?.update) {
    return;
  }

  try {
    const currentWindow = await chrome.windows.getCurrent();
    if (typeof currentWindow.id !== 'number') {
      return;
    }

    await chrome.windows.update(currentWindow.id, {
      width,
      height,
      focused: true,
    });
  } catch {
    // Best-effort resize only.
  }
}

async function hideCurrentWindow(): Promise<void> {
  if (!chrome.windows?.getCurrent || !chrome.windows?.update) {
    return;
  }

  try {
    const currentWindow = await chrome.windows.getCurrent();
    if (typeof currentWindow.id !== 'number') {
      return;
    }

    // Move the popup just off the bottom-right corner of the operator's screen and shrink
    // it to a tiny footprint. We deliberately do NOT use state: 'minimized' because that
    // pauses the page lifecycle and freezes the MediaStreamTrackProcessor frame pump in
    // some Chromium versions, which produces a blank stream on the GUI side.
    const screenWidth = (globalThis as { screen?: { width?: number } }).screen?.width ?? 1920;
    const screenHeight = (globalThis as { screen?: { height?: number } }).screen?.height ?? 1080;

    await chrome.windows.update(currentWindow.id, {
      state: 'normal',
      focused: false,
      width: 200,
      height: 80,
      left: Math.max(0, screenWidth - 210),
      top: Math.max(0, screenHeight - 90),
    });
  } catch {
    // Best-effort reposition only.
  }
}

void initialize();
