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
  message?: string;
};

const previewElement = document.querySelector<HTMLVideoElement>('#preview');
const statusElement = document.querySelector<HTMLElement>('#status');
const startButton = document.querySelector<HTMLButtonElement>('#start-button');
const stopButton = document.querySelector<HTMLButtonElement>('#stop-button');

let activeStream: MediaStream | null = null;
let isStarting = false;
let framePumpTimer: number | null = null;
let frameSequence = 0;
let frameEncodeInFlight = false;
let streamSocket: WebSocket | null = null;
let streamSocketReady: Promise<void> | null = null;
const streamCanvas = document.createElement('canvas');

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

  renderStatus(response?.status?.message ?? 'Browser prompt is ready. Click Start Streaming to open the picker.');
  syncControls();
}

async function beginStartFlow(): Promise<void> {
  if (isStarting || activeStream) {
    return;
  }

  isStarting = true;
  syncControls();
  renderStatus('Opening the Chrome screen picker...');

  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({
      audio: false,
      video: {
        frameRate: { ideal: 30, max: 30 },
        width: { ideal: 1920 },
        height: { ideal: 1080 },
      } as MediaTrackConstraints,
    });

    activeStream = stream;
    if (previewElement) {
      previewElement.srcObject = stream;
    }
    const [videoTrack] = stream.getVideoTracks();
    videoTrack?.addEventListener('ended', () => {
      stopShare('The user ended screen sharing.');
    });

    await ensureStreamSocket();
    startFramePump();

    await chrome.runtime.sendMessage({
      type: 'screen-share-viewer-status',
      status: {
        state: 'active',
        active: true,
        sourceLabel: videoTrack?.label || 'Screen share',
        updatedAt: new Date().toISOString(),
        message: 'Screen stream is active. Live frames are being sent to the Python desktop app.',
      },
    });
    await minimizeCurrentWindow();
    renderStatus('Streaming to the Python desktop app. Use the Stop Sharing button on the client page to end the session.');
  } catch (error) {
    const message = toShareErrorMessage(error);
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

    await openStreamSocket(response.targetUrl);
  })();

  try {
    await streamSocketReady;
  } finally {
    streamSocketReady = null;
  }
}

async function openStreamSocket(targetUrl: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = new WebSocket(targetUrl);
    let settled = false;

    const finalizeFailure = (error: Error) => {
      if (settled) {
        return;
      }

      settled = true;
      streamSocket = null;
      reject(error);
    };

    socket.addEventListener('open', () => {
      if (settled) {
        return;
      }

      settled = true;
      streamSocket = socket;
      socket.send(
        JSON.stringify({
          type: 'screen-share.stream-register',
          clientId: crypto.randomUUID(),
          name: 'screen-share-viewer',
          version: __EXTENSION_VERSION__,
        })
      );
      resolve();
    });

    socket.addEventListener('error', () => {
      finalizeFailure(new Error('Unable to connect the screen share stream to the desktop bridge.'));
    });

    socket.addEventListener('close', () => {
      if (!settled) {
        finalizeFailure(new Error('The screen share stream connection closed before it was ready.'));
        return;
      }

      if (streamSocket === socket) {
        streamSocket = null;
      }
    });
  });
}

function closeStreamSocket(): void {
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

function startFramePump(): void {
  stopFramePump();
  frameSequence = 0;
  frameEncodeInFlight = false;
  framePumpTimer = window.setInterval(() => {
    void pushNextFrame();
  }, 125);
}

function stopFramePump(): void {
  if (framePumpTimer !== null) {
    window.clearInterval(framePumpTimer);
    framePumpTimer = null;
  }
  frameEncodeInFlight = false;
}

async function pushNextFrame(): Promise<void> {
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
    const context = streamCanvas.getContext('2d', { alpha: false });
    if (!context) {
      return;
    }

    context.drawImage(previewElement, 0, 0, frameWidth, frameHeight);
    const blob = await new Promise<Blob | null>((resolve) => {
      streamCanvas.toBlob(resolve, 'image/jpeg', 0.72);
    });
    if (!blob) {
      return;
    }

    const imageBytes = new Uint8Array(await blob.arrayBuffer());
    const metadataBytes = new TextEncoder().encode(
      JSON.stringify({
        type: 'screen-share.frame.binary',
        mimeType: 'image/jpeg',
        capturedAt: new Date().toISOString(),
        width: frameWidth,
        height: frameHeight,
        sequence: frameSequence,
      })
    );
    frameSequence += 1;

    const envelope = new Uint8Array(4 + metadataBytes.length + imageBytes.length);
    const view = new DataView(envelope.buffer);
    view.setUint32(0, metadataBytes.length);
    envelope.set(metadataBytes, 4);
    envelope.set(imageBytes, 4 + metadataBytes.length);
    streamSocket.send(envelope.buffer);
  } finally {
    frameEncodeInFlight = false;
  }
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

async function minimizeCurrentWindow(): Promise<void> {
  if (!chrome.windows?.getCurrent || !chrome.windows?.update) {
    return;
  }

  try {
    const currentWindow = await chrome.windows.getCurrent();
    if (typeof currentWindow.id !== 'number') {
      return;
    }

    await chrome.windows.update(currentWindow.id, {
      state: 'minimized',
    });
  } catch {
    // Best-effort minimize only.
  }
}

void initialize();