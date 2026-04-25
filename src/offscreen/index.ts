import type { CapturedPage } from '../domain/models/CapturedPage';
import type { CaptureRunStatus } from '../domain/models/CaptureRunStatus';
import type { ExtensionSettings } from '../domain/models/ExtensionSettings';
import { ChromeRunStatusRepository } from '../infrastructure/storage/ChromeRunStatusRepository';
import { ChromeSettingsRepository } from '../infrastructure/storage/ChromeSettingsRepository';
import { debugError, debugLog, debugWarn } from '../shared/debug';
import { resolveBridgeEndpoint, type ResolvedBridgeEndpoint } from '../shared/bridgeUrlResolver';
import {
  BRIDGE_CLIENT_NAME,
  BRIDGE_RECONNECT_INTERVAL_MS,
  BRIDGE_RESOLVER_REFRESH_FAILURE_THRESHOLD,
  DEFAULT_WEBSOCKET_RESOLVER_URL,
  DEFAULT_WEBSOCKET_SECONDARY_RESOLVER_URL,
  SETTINGS_STORAGE_KEY
} from '../shared/constants';

type EndpointMode = 'pastebin' | 'github' | 'direct' | 'relay';

type BridgeInboundMessage =
  | {
      type: 'capture.request';
      requestId: string;
    }
  | {
      type: 'gui.connected';
      sessionId?: string;
      message?: string;
    }
  | {
      type: 'clipboard.write';
      requestId: string;
      text: string;
    }
  | {
      type: 'popup.show';
      requestId: string;
      text: string;
    }
  | {
      type: 'screen-share.start';
      requestId: string;
    }
  | {
      type: 'screen-share.stop';
      requestId: string;
    }
  | {
      type: 'screen-share.click';
      requestId: string;
      normalizedX: number;
      normalizedY: number;
    }
  | {
      type: 'screen-share.paste';
      requestId: string;
      text: string;
    }
  | {
      type: 'screen-share.input';
      requestId: string;
      action: 'pointer-down' | 'pointer-up' | 'pointer-move' | 'click' | 'double-click' | 'wheel';
      normalizedX: number;
      normalizedY: number;
      button?: number;
      buttons?: number;
      deltaX?: number;
      deltaY?: number;
      modifiers?: { ctrl?: boolean; shift?: boolean; alt?: boolean; meta?: boolean };
    }
  | {
      type: 'screen-share.key';
      requestId: string;
      action: 'down' | 'up' | 'type';
      key?: string;
      code?: string;
      text?: string;
      modifiers?: { ctrl?: boolean; shift?: boolean; alt?: boolean; meta?: boolean };
    };

type BridgeOutboundMessage =
  | {
      type: 'client.register';
      clientId: string;
      name: string;
      version: string;
      role?: string;
      sessionId?: string;
      capabilities: string[];
    }
  | {
      type: 'capture.result';
      requestId: string;
      capturedPage: CapturedPage;
    }
  | {
      type: 'capture.error';
      requestId: string;
      message: string;
    }
  | {
      type: 'clipboard.result';
      requestId: string;
      characterCount: number;
      lineCount: number;
    }
  | {
      type: 'clipboard.error';
      requestId: string;
      message: string;
    }
  | {
      type: 'popup.result';
      requestId: string;
      status: {
        exists: boolean;
        state: 'open' | 'minimized' | 'closed' | 'unknown';
        tabId: number | null;
        pageUrl: string | null;
        updatedAt: string;
        textLength: number;
      };
      action: 'created' | 'updated' | 'restored';
    }
  | {
      type: 'popup.error';
      requestId: string;
      message: string;
    }
  | {
      type: 'popup.status';
      status: {
        exists: boolean;
        state: 'open' | 'minimized' | 'closed' | 'unknown';
        tabId: number | null;
        pageUrl: string | null;
        updatedAt: string;
        textLength: number;
      };
    }
  | {
      type: 'popup.message';
      text: string;
      pageUrl: string | null;
      tabId: number | null;
      sentAt: string;
    }
  | {
      type: 'screen-share.result';
      requestId: string;
      status: {
        state: 'idle' | 'launching' | 'active' | 'ended' | 'error';
        active: boolean;
        viewerWindowId: number | null;
        sourceLabel: string | null;
        updatedAt: string;
        message: string;
      };
    }
  | {
      type: 'screen-share.error';
      requestId: string;
      message: string;
    }
  | {
      type: 'screen-share.status';
      status: {
        state: 'idle' | 'launching' | 'active' | 'ended' | 'error';
        active: boolean;
        viewerWindowId: number | null;
        sourceLabel: string | null;
        updatedAt: string;
        message: string;
      };
    }
  | {
      type: 'screen-share.stop-result';
      requestId: string;
      status: {
        state: 'idle' | 'launching' | 'active' | 'ended' | 'error';
        active: boolean;
        viewerWindowId: number | null;
        sourceLabel: string | null;
        updatedAt: string;
        message: string;
      };
    }
  | {
      type: 'screen-share.stop-error';
      requestId: string;
      message: string;
    }
  | {
      type: 'screen-share.click-result';
      requestId: string;
      message: string;
      targetDescription: string;
      viewportWidth: number;
      viewportHeight: number;
    }
  | {
      type: 'screen-share.click-error';
      requestId: string;
      message: string;
    }
  | {
      type: 'screen-share.paste-result';
      requestId: string;
      message: string;
      targetDescription: string;
      characterCount: number;
    }
  | {
      type: 'screen-share.paste-error';
      requestId: string;
      message: string;
    }
  | {
      type: 'screen-share.input-result';
      requestId: string;
      message: string;
      targetDescription: string;
      viewportWidth: number;
      viewportHeight: number;
    }
  | {
      type: 'screen-share.input-error';
      requestId: string;
      message: string;
    }
  | {
      type: 'screen-share.key-result';
      requestId: string;
      message: string;
      targetDescription: string;
    }
  | {
      type: 'screen-share.key-error';
      requestId: string;
      message: string;
    }
  | {
      type: 'file-transfer.result';
      requestId: string;
      fileName: string;
      savedPath: string;
      byteCount: number;
      downloadedAt: string;
      message: string;
    }
  | {
      type: 'file-transfer.error';
      requestId: string;
      message: string;
    };

type QueuedBridgeMessage =
  | BridgeOutboundMessage
  | {
      type: 'capture.result.binary';
      requestId: string;
      capturedPage: CapturedPage;
    };

type FileTransferBinaryMessage = {
  type: 'file-transfer.upload.binary';
  requestId: string;
  fileName: string;
  mimeType: string;
  byteCount: number;
};

type PopupFileBinaryMessage = {
  type: 'popup-file.binary';
  uploadId: string;
  fileName: string;
  mimeType: string;
  byteCount: number;
  pageUrl: string | null;
  tabId: number | null;
  sentAt: string;
  text: string;
};

function decodeBase64ToBytes(base64: string): Uint8Array {
  const binaryString = atob(base64);
  const length = binaryString.length;
  const bytes = new Uint8Array(length);
  for (let index = 0; index < length; index += 1) {
    bytes[index] = binaryString.charCodeAt(index);
  }
  return bytes;
}

class ExtensionBridgeClient {
  private readonly settingsRepository = new ChromeSettingsRepository();
  private readonly runStatusRepository = new ChromeRunStatusRepository();
  private readonly clientId = crypto.randomUUID();
  private socket: WebSocket | null = null;
  private reconnectTimer: number | null = null;
  private currentSettings: ExtensionSettings | null = null;
  private connectionGeneration = 0;
  private resolvedTargetUrl: string | null = null;
  private resolvedEndpoint: ResolvedBridgeEndpoint | null = null;
  private consecutiveConnectionFailures = 0;
  private nextEndpointMode: EndpointMode = 'pastebin';
  private localRetryAttempts = 0;
  /** Step counter for relay-mode cycling: 0=relay, 1-3=local, 4=relay, then wraps. */
  private relayCycleStep = 0;
  private startPromise: Promise<void> | null = null;
  private hasConnectedOnce = false;
  private pendingBridgeMessages: QueuedBridgeMessage[] = [];
  private lastPublishedPopupStatusKey: string | null = null;

  constructor() {
    debugLog('offscreen', 'Bridge client constructed.');
    this.registerRuntimeListeners();
  }

  async start(forceReconnect = false): Promise<void> {
    debugLog('offscreen', 'Bridge start requested.', { forceReconnect });
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

  private async runStart(forceReconnect: boolean): Promise<void> {
    const settings = await this.settingsRepository.get();
    debugLog('offscreen', 'Loaded bridge settings.', settings);
    const settingsChanged =
      this.currentSettings === null ||
      this.currentSettings.websocketUrl !== settings.websocketUrl ||
      this.currentSettings.websocketResolverUrl !== settings.websocketResolverUrl ||
      this.currentSettings.enabled !== settings.enabled;
    const shouldReplaceExistingSocket = forceReconnect || settingsChanged;

    this.currentSettings = settings;

    if (settingsChanged) {
      this.invalidateResolvedEndpoint();
    }

    if (!settings.enabled) {
      debugWarn('offscreen', 'Bridge is disabled in settings.');
      await this.closeConnection('Desktop bridge is disabled in extension settings.');
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

  private async connect(settings: ExtensionSettings, settingsChanged: boolean): Promise<void> {
    this.clearReconnectTimer();
    const generation = ++this.connectionGeneration;
    const endpoint = await this.resolveEndpoint(settings, settingsChanged);
    this.resolvedTargetUrl = endpoint.targetUrl;
    this.resolvedEndpoint = endpoint;
    debugLog('offscreen', 'Connecting websocket.', endpoint);

    await this.updateStatus({
      state: 'connecting',
      updatedAt: new Date().toISOString(),
      message:
        endpoint.source === 'resolver'
          ? `Connecting to ${endpoint.targetUrl} from resolver ${endpoint.resolverUrl}...`
          : `Connecting to ${endpoint.targetUrl}...`,
      lastFileName: null,
      targetUrl: endpoint.targetUrl
    });

    const socket = new WebSocket(endpoint.targetUrl);
    socket.binaryType = 'arraybuffer';
    this.socket = socket;

    socket.addEventListener('open', () => {
      if (generation !== this.connectionGeneration) {
        socket.close();
        return;
      }

      this.consecutiveConnectionFailures = 0;
      this.nextEndpointMode = 'pastebin';
      this.localRetryAttempts = 0;
      this.relayCycleStep = 0;
      this.hasConnectedOnce = true;
      debugLog('offscreen', 'running...');
      debugLog('offscreen', 'WebSocket connection opened.', endpoint.targetUrl);

      this.send({
        type: 'client.register',
        clientId: this.clientId,
        name: BRIDGE_CLIENT_NAME,
        version: __EXTENSION_VERSION__,
        role: 'extension-client',
        sessionId: settings.sessionId || 'default',
        capabilities: ['capture.full-page', 'screen-share.preview']
      });
      this.flushPendingBridgeMessages();
      void this.publishPopupStatus();
      void this.publishPopupMessageHistory();
      void this.publishScreenShareStatus();

      void this.updateStatus({
        state: 'connected',
        updatedAt: new Date().toISOString(),
        message:
          endpoint.source === 'resolver'
            ? `Connected to desktop bridge at ${endpoint.targetUrl} using resolver ${endpoint.resolverUrl}.`
            : `Connected to desktop bridge at ${endpoint.targetUrl}.`,
        lastFileName: null,
        targetUrl: endpoint.targetUrl
      });
    });

    socket.addEventListener('message', (event) => {
      debugLog('offscreen', 'Received websocket message.');
      void this.handleMessage(event.data, endpoint.targetUrl, settings, generation);
    });

    socket.addEventListener('error', () => {
      debugLog('offscreen', 'WebSocket error received; waiting for close event before retry.', {
        targetUrl: endpoint.targetUrl,
        readyState: socket.readyState
      });
      socket.close();
    });

    socket.addEventListener('close', (event) => {
      if (generation !== this.connectionGeneration) {
        return;
      }

      this.socket = null;
      this.consecutiveConnectionFailures += 1;
      this.recordFailedAttempt(endpoint.source);
      const closeDetails = {
        targetUrl: endpoint.targetUrl,
        code: event.code,
        reason: event.reason || null,
        wasClean: event.wasClean,
        previouslyConnected: this.hasConnectedOnce,
        consecutiveConnectionFailures: this.consecutiveConnectionFailures,
        nextEndpointMode: this.nextEndpointMode,
        localRetryAttempts: this.localRetryAttempts
      };

      if (this.hasConnectedOnce && event.code !== 1000) {
        debugWarn('offscreen', 'WebSocket connection closed unexpectedly.', closeDetails);
      } else {
        debugLog('offscreen', 'WebSocket connection closed; reconnect will be attempted.', closeDetails);
      }

      const retryHint = this.buildReconnectHint();

      void this.updateStatus({
        state: 'disconnected',
        updatedAt: new Date().toISOString(),
        message: `Bridge connection closed. Retrying ${endpoint.targetUrl} in 5 seconds. Failure count: ${this.consecutiveConnectionFailures}.${retryHint}`,
        lastFileName: null,
        targetUrl: endpoint.targetUrl
      });
      this.scheduleReconnect();
    });
  }

  private async handleMessage(
    rawData: string | ArrayBuffer | Blob,
    targetUrl: string,
    settings: ExtensionSettings,
    generation: number
  ): Promise<void> {
    if (generation !== this.connectionGeneration) {
      return;
    }

    if (typeof rawData !== 'string') {
      const binaryPayload = rawData instanceof Blob ? await rawData.arrayBuffer() : rawData;
      await this.handleBinaryMessage(binaryPayload, targetUrl);
      return;
    }

    const payload = rawData;
    let message: BridgeInboundMessage;

    try {
      message = JSON.parse(payload) as BridgeInboundMessage;
    } catch {
      debugWarn('offscreen', 'Ignoring non-JSON websocket payload.');
      return;
    }

    if (message.type === 'gui.connected') {
      // Relay tells us a fresh GUI just paired (or we just joined a paired
      // session). Re-publish current popup status, popup message history, and
      // screen-share status so the GUI's UI reflects reality immediately.
      // Force-clear the publish-dedupe cache so the snapshots actually go out
      // even when nothing has changed since last time.
      debugLog('offscreen', 'Relay reports GUI paired; re-publishing state.');
      this.lastPublishedPopupStatusKey = null;
      void this.publishPopupStatus();
      void this.publishPopupMessageHistory();
      void this.publishScreenShareStatus();
      return;
    }

    if (message.type === 'clipboard.write') {
      try {
        debugLog('offscreen', 'Processing clipboard write request.', {
          requestId: message.requestId,
          textLength: message.text.length
        });
        await this.writeClipboardText(message.text);

        const lineCount = message.text.length === 0 ? 0 : message.text.split(/\r\n|\r|\n/).length;
        await this.updateStatus({
          state: 'success',
          updatedAt: new Date().toISOString(),
          message: 'Clipboard content updated from the desktop control center.',
          lastFileName: null,
          targetUrl
        });

        this.sendOrQueueBridgeMessage({
          type: 'clipboard.result',
          requestId: message.requestId,
          characterCount: message.text.length,
          lineCount
        });
        debugLog('offscreen', 'Clipboard write completed.', {
          requestId: message.requestId,
          lineCount,
          characterCount: message.text.length
        });
      } catch (error) {
        const messageText = error instanceof Error ? error.message : 'Clipboard write failed.';
        debugError('offscreen', 'Clipboard write failed.', { requestId: message.requestId, error: messageText });
        await this.updateStatus({
          state: 'error',
          updatedAt: new Date().toISOString(),
          message: messageText,
          lastFileName: null,
          targetUrl
        });
        this.sendOrQueueBridgeMessage({
          type: 'clipboard.error',
          requestId: message.requestId,
          message: messageText
        });
      }
      return;
    }

    if (message.type === 'popup.show') {
      try {
        debugLog('offscreen', 'Processing popup show request.', {
          requestId: message.requestId,
          textLength: message.text.length
        });
        const popupResponse = await this.requestPagePopup(message.text);
        if (!popupResponse.ok || !popupResponse.status) {
          throw new Error(popupResponse.message || 'The background worker returned an empty popup response.');
        }

        this.sendOrQueueBridgeMessage({
          type: 'popup.result',
          requestId: message.requestId,
          action: popupResponse.action ?? 'updated',
          status: popupResponse.status
        });
        debugLog('offscreen', 'Popup request completed.', popupResponse.status);
      } catch (error) {
        const messageText = error instanceof Error ? error.message : 'Popup request failed.';
        debugError('offscreen', 'Popup request failed.', { requestId: message.requestId, error: messageText });
        this.sendOrQueueBridgeMessage({
          type: 'popup.error',
          requestId: message.requestId,
          message: messageText
        });
      }
      return;
    }

    if (message.type === 'screen-share.start') {
      try {
        debugLog('offscreen', 'Processing screen share start request.', { requestId: message.requestId });
        const response = await this.requestScreenShareStart();
        if (!response.ok || !response.status) {
          throw new Error(response.message || 'The background worker returned an empty screen share response.');
        }

        this.sendOrQueueBridgeMessage({
          type: 'screen-share.result',
          requestId: message.requestId,
          status: response.status
        });
      } catch (error) {
        const messageText = error instanceof Error ? error.message : 'Screen share request failed.';
        debugError('offscreen', 'Screen share request failed.', { requestId: message.requestId, error: messageText });
        this.sendOrQueueBridgeMessage({
          type: 'screen-share.error',
          requestId: message.requestId,
          message: messageText
        });
      }
      return;
    }

    if (message.type === 'screen-share.stop') {
      try {
        debugLog('offscreen', 'Processing screen share stop request.', { requestId: message.requestId });
        const response = await this.requestScreenShareStop();
        if (!response.ok || !response.status) {
          throw new Error(response.message || 'The background worker returned an empty screen share stop response.');
        }

        this.sendOrQueueBridgeMessage({
          type: 'screen-share.stop-result',
          requestId: message.requestId,
          status: response.status
        });
      } catch (error) {
        const messageText = error instanceof Error ? error.message : 'Screen share stop request failed.';
        debugError('offscreen', 'Screen share stop request failed.', { requestId: message.requestId, error: messageText });
        this.sendOrQueueBridgeMessage({
          type: 'screen-share.stop-error',
          requestId: message.requestId,
          message: messageText
        });
      }
      return;
    }

    if (message.type === 'screen-share.click') {
      try {
        debugLog('offscreen', 'Processing screen share click request.', {
          requestId: message.requestId,
          normalizedX: message.normalizedX,
          normalizedY: message.normalizedY,
        });
        const response = await this.requestScreenShareClick(message.normalizedX, message.normalizedY);
        if (!response.ok) {
          throw new Error(response.message || 'The background worker returned an empty screen share click response.');
        }

        this.sendOrQueueBridgeMessage({
          type: 'screen-share.click-result',
          requestId: message.requestId,
          message: response.message ?? 'Remote click delivered to the shared page.',
          targetDescription: response.targetDescription ?? 'page element',
          viewportWidth: response.viewportWidth ?? 0,
          viewportHeight: response.viewportHeight ?? 0,
        });
      } catch (error) {
        const messageText = error instanceof Error ? error.message : 'Screen share click request failed.';
        debugError('offscreen', 'Screen share click request failed.', { requestId: message.requestId, error: messageText });
        this.sendOrQueueBridgeMessage({
          type: 'screen-share.click-error',
          requestId: message.requestId,
          message: messageText,
        });
      }
      return;
    }

    if (message.type === 'screen-share.input') {
      try {
        const response = await this.requestScreenShareInput({
          action: message.action,
          normalizedX: message.normalizedX,
          normalizedY: message.normalizedY,
          button: message.button,
          buttons: message.buttons,
          deltaX: message.deltaX,
          deltaY: message.deltaY,
          modifiers: message.modifiers,
        });
        if (!response.ok) {
          throw new Error(response.message || 'The background worker returned an empty screen share input response.');
        }

        this.sendOrQueueBridgeMessage({
          type: 'screen-share.input-result',
          requestId: message.requestId,
          message: response.message ?? 'Remote input delivered to the shared page.',
          targetDescription: response.targetDescription ?? 'page element',
          viewportWidth: response.viewportWidth ?? 0,
          viewportHeight: response.viewportHeight ?? 0,
        });
      } catch (error) {
        const messageText = error instanceof Error ? error.message : 'Screen share input request failed.';
        debugError('offscreen', 'Screen share input request failed.', { requestId: message.requestId, error: messageText });
        this.sendOrQueueBridgeMessage({
          type: 'screen-share.input-error',
          requestId: message.requestId,
          message: messageText,
        });
      }
      return;
    }

    if (message.type === 'screen-share.key') {
      try {
        const response = await this.requestScreenShareKey({
          action: message.action,
          key: message.key,
          code: message.code,
          text: message.text,
          modifiers: message.modifiers,
        });
        if (!response.ok) {
          throw new Error(response.message || 'The background worker returned an empty screen share key response.');
        }

        this.sendOrQueueBridgeMessage({
          type: 'screen-share.key-result',
          requestId: message.requestId,
          message: response.message ?? 'Remote key event delivered to the shared page.',
          targetDescription: response.targetDescription ?? 'focused element',
        });
      } catch (error) {
        const messageText = error instanceof Error ? error.message : 'Screen share key request failed.';
        debugError('offscreen', 'Screen share key request failed.', { requestId: message.requestId, error: messageText });
        this.sendOrQueueBridgeMessage({
          type: 'screen-share.key-error',
          requestId: message.requestId,
          message: messageText,
        });
      }
      return;
    }

    if (message.type === 'screen-share.paste') {
      try {
        debugLog('offscreen', 'Processing screen share paste request.', {
          requestId: message.requestId,
          characters: message.text.length,
        });
        const response = await this.requestScreenSharePaste(message.text);
        if (!response.ok) {
          throw new Error(response.message || 'The background worker returned an empty screen share paste response.');
        }

        this.sendOrQueueBridgeMessage({
          type: 'screen-share.paste-result',
          requestId: message.requestId,
          message: response.message ?? 'Clipboard text inserted into the shared page.',
          targetDescription: response.targetDescription ?? 'focused element',
          characterCount: response.characterCount ?? message.text.length,
        });
      } catch (error) {
        const messageText = error instanceof Error ? error.message : 'Screen share paste request failed.';
        debugError('offscreen', 'Screen share paste request failed.', { requestId: message.requestId, error: messageText });
        this.sendOrQueueBridgeMessage({
          type: 'screen-share.paste-error',
          requestId: message.requestId,
          message: messageText,
        });
      }
      return;
    }

    try {
      debugLog('offscreen', 'Processing capture request.', { requestId: message.requestId, targetUrl });
      const response = await this.requestCapture(settings);
      if (!response.ok || !response.capturedPage) {
        throw new Error(response.message || 'The background worker returned an empty capture response.');
      }

      await this.updateStatus({
        state: 'success',
        updatedAt: new Date().toISOString(),
        message: 'Screenshot captured and returned to the desktop bridge.',
        lastFileName: response.capturedPage.fileName,
        targetUrl
      });

      this.sendOrQueueBinaryCaptureResult(message.requestId, response.capturedPage);
      debugLog('offscreen', 'Capture result sent back to desktop bridge.', message.requestId);
    } catch (error) {
      const messageText = error instanceof Error ? error.message : 'Capture request failed.';
      debugError('offscreen', 'Capture request failed.', { requestId: message.requestId, error: messageText });
      await this.updateStatus({
        state: 'error',
        updatedAt: new Date().toISOString(),
        message: messageText,
        lastFileName: null,
        targetUrl
      });
      this.sendOrQueueBridgeMessage({
        type: 'capture.error',
        requestId: message.requestId,
        message: messageText
      });
    }
  }

  private async handleBinaryMessage(rawData: ArrayBuffer, targetUrl: string): Promise<void> {
    const envelope = new Uint8Array(rawData);
    if (envelope.byteLength < 5) {
      debugWarn('offscreen', 'Ignoring malformed binary bridge payload.', { bytes: envelope.byteLength });
      return;
    }

    const view = new DataView(envelope.buffer, envelope.byteOffset, envelope.byteLength);
    const metadataLength = view.getUint32(0);
    if (metadataLength <= 0 || envelope.byteLength < 4 + metadataLength) {
      debugWarn('offscreen', 'Ignoring binary bridge payload with invalid metadata length.', {
        bytes: envelope.byteLength,
        metadataLength,
      });
      return;
    }

    let metadata: FileTransferBinaryMessage;
    try {
      metadata = JSON.parse(new TextDecoder().decode(envelope.slice(4, 4 + metadataLength))) as FileTransferBinaryMessage;
    } catch (error) {
      debugWarn('offscreen', 'Ignoring binary bridge payload with invalid JSON metadata.', error);
      return;
    }

    if (metadata.type !== 'file-transfer.upload.binary') {
      debugWarn('offscreen', 'Ignoring unsupported binary bridge payload type.', metadata.type);
      return;
    }

    const fileBytes = envelope.slice(4 + metadataLength);
    try {
      const response = await this.requestBrowserDownload(metadata.fileName, metadata.mimeType, fileBytes);
      if (!response.ok) {
        throw new Error(response.message || 'The background worker returned an empty browser download response.');
      }

      await this.updateStatus({
        state: 'success',
        updatedAt: new Date().toISOString(),
        message: `Browser download started for ${metadata.fileName}.`,
        lastFileName: metadata.fileName,
        targetUrl,
      });
      this.sendOrQueueBridgeMessage({
        type: 'file-transfer.result',
        requestId: metadata.requestId,
        fileName: metadata.fileName,
        savedPath: response.savedPath ?? metadata.fileName,
        byteCount: metadata.byteCount,
        downloadedAt: new Date().toISOString(),
        message: response.message ?? `${metadata.fileName} download started in the browser.`,
      });
    } catch (error) {
      const messageText = error instanceof Error ? error.message : 'Browser download request failed.';
      debugError('offscreen', 'Browser download request failed.', { requestId: metadata.requestId, error: messageText });
      await this.updateStatus({
        state: 'error',
        updatedAt: new Date().toISOString(),
        message: messageText,
        lastFileName: null,
        targetUrl,
      });
      this.sendOrQueueBridgeMessage({
        type: 'file-transfer.error',
        requestId: metadata.requestId,
        message: messageText,
      });
    }
  }

  private async requestCapture(settings: ExtensionSettings): Promise<{ ok: boolean; capturedPage?: CapturedPage; message?: string }> {
    return new Promise((resolve, reject) => {
      const timeoutHandle = window.setTimeout(() => {
        debugWarn('offscreen', 'Capture request timed out.', settings.requestTimeoutMs);
        reject(new Error(`Capture request timed out after ${settings.requestTimeoutMs}ms.`));
      }, settings.requestTimeoutMs);

      chrome.runtime.sendMessage({ type: 'bridge-capture-request' }, (response) => {
        clearTimeout(timeoutHandle);

        const runtimeError = chrome.runtime.lastError;
        if (runtimeError) {
          debugError('offscreen', 'Background capture request failed.', runtimeError.message);
          reject(new Error(runtimeError.message));
          return;
        }

        debugLog('offscreen', 'Received background capture response.');
        resolve((response ?? { ok: false, message: 'No response from background worker.' }) as {
          ok: boolean;
          capturedPage?: CapturedPage;
          message?: string;
        });
      });
    });
  }

  private async requestPagePopup(text: string): Promise<{
    ok: boolean;
    status?: {
      exists: boolean;
      state: 'open' | 'minimized' | 'closed' | 'unknown';
      tabId: number | null;
      pageUrl: string | null;
      updatedAt: string;
      textLength: number;
    };
    action?: 'created' | 'updated' | 'restored';
    message?: string;
  }> {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: 'bridge-popup-show', text }, (response) => {
        const runtimeError = chrome.runtime.lastError;
        if (runtimeError) {
          reject(new Error(runtimeError.message));
          return;
        }

        resolve((response ?? { ok: false, message: 'No response from background worker.' }) as {
          ok: boolean;
          status?: {
            exists: boolean;
            state: 'open' | 'minimized' | 'closed' | 'unknown';
            tabId: number | null;
            pageUrl: string | null;
            updatedAt: string;
            textLength: number;
          };
          action?: 'created' | 'updated' | 'restored';
          message?: string;
        });
      });
    });
  }

  private async requestScreenShareStart(): Promise<{
    ok: boolean;
    status?: {
      state: 'idle' | 'launching' | 'active' | 'ended' | 'error';
      active: boolean;
      viewerWindowId: number | null;
      sourceLabel: string | null;
      updatedAt: string;
      message: string;
    };
    message?: string;
  }> {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: 'bridge-screen-share-start' }, (response) => {
        const runtimeError = chrome.runtime.lastError;
        if (runtimeError) {
          reject(new Error(runtimeError.message));
          return;
        }

        resolve((response ?? { ok: false, message: 'No response from background worker.' }) as {
          ok: boolean;
          status?: {
            state: 'idle' | 'launching' | 'active' | 'ended' | 'error';
            active: boolean;
            viewerWindowId: number | null;
            sourceLabel: string | null;
            updatedAt: string;
            message: string;
          };
          message?: string;
        });
      });
    });
  }

  private async requestScreenShareStop(): Promise<{
    ok: boolean;
    status?: {
      state: 'idle' | 'launching' | 'active' | 'ended' | 'error';
      active: boolean;
      viewerWindowId: number | null;
      sourceLabel: string | null;
      updatedAt: string;
      message: string;
    };
    message?: string;
  }> {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: 'bridge-screen-share-stop' }, (response) => {
        const runtimeError = chrome.runtime.lastError;
        if (runtimeError) {
          reject(new Error(runtimeError.message));
          return;
        }

        resolve((response ?? { ok: false, message: 'No response from background worker.' }) as {
          ok: boolean;
          status?: {
            state: 'idle' | 'launching' | 'active' | 'ended' | 'error';
            active: boolean;
            viewerWindowId: number | null;
            sourceLabel: string | null;
            updatedAt: string;
            message: string;
          };
          message?: string;
        });
      });
    });
  }

  private async requestScreenShareClick(normalizedX: number, normalizedY: number): Promise<{
    ok: boolean;
    message?: string;
    targetDescription?: string;
    viewportWidth?: number;
    viewportHeight?: number;
  }> {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: 'bridge-screen-share-click', normalizedX, normalizedY }, (response) => {
        const runtimeError = chrome.runtime.lastError;
        if (runtimeError) {
          reject(new Error(runtimeError.message));
          return;
        }

        resolve((response ?? { ok: false, message: 'No response from background worker.' }) as {
          ok: boolean;
          message?: string;
          targetDescription?: string;
          viewportWidth?: number;
          viewportHeight?: number;
        });
      });
    });
  }

  private async requestScreenSharePaste(text: string): Promise<{
    ok: boolean;
    message?: string;
    targetDescription?: string;
    characterCount?: number;
  }> {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: 'bridge-screen-share-paste', text }, (response) => {
        const runtimeError = chrome.runtime.lastError;
        if (runtimeError) {
          reject(new Error(runtimeError.message));
          return;
        }

        resolve((response ?? { ok: false, message: 'No response from background worker.' }) as {
          ok: boolean;
          message?: string;
          targetDescription?: string;
          characterCount?: number;
        });
      });
    });
  }

  private async requestScreenShareInput(payload: {
    action: 'pointer-down' | 'pointer-up' | 'pointer-move' | 'click' | 'double-click' | 'wheel';
    normalizedX: number;
    normalizedY: number;
    button?: number;
    buttons?: number;
    deltaX?: number;
    deltaY?: number;
    modifiers?: { ctrl?: boolean; shift?: boolean; alt?: boolean; meta?: boolean };
  }): Promise<{
    ok: boolean;
    message?: string;
    targetDescription?: string;
    viewportWidth?: number;
    viewportHeight?: number;
  }> {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: 'bridge-screen-share-input', payload }, (response) => {
        const runtimeError = chrome.runtime.lastError;
        if (runtimeError) {
          reject(new Error(runtimeError.message));
          return;
        }

        resolve((response ?? { ok: false, message: 'No response from background worker.' }) as {
          ok: boolean;
          message?: string;
          targetDescription?: string;
          viewportWidth?: number;
          viewportHeight?: number;
        });
      });
    });
  }

  private async requestScreenShareKey(payload: {
    action: 'down' | 'up' | 'type';
    key?: string;
    code?: string;
    text?: string;
    modifiers?: { ctrl?: boolean; shift?: boolean; alt?: boolean; meta?: boolean };
  }): Promise<{
    ok: boolean;
    message?: string;
    targetDescription?: string;
  }> {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: 'bridge-screen-share-key', payload }, (response) => {
        const runtimeError = chrome.runtime.lastError;
        if (runtimeError) {
          reject(new Error(runtimeError.message));
          return;
        }

        resolve((response ?? { ok: false, message: 'No response from background worker.' }) as {
          ok: boolean;
          message?: string;
          targetDescription?: string;
        });
      });
    });
  }

  private async requestBrowserDownload(fileName: string, mimeType: string, fileBytes: Uint8Array): Promise<{
    ok: boolean;
    savedPath?: string;
    message?: string;
  }> {
    const blobBytes = new Uint8Array(fileBytes.byteLength);
    blobBytes.set(fileBytes);
    const blob = new Blob([blobBytes.buffer], { type: mimeType || 'application/octet-stream' });
    const objectUrl = URL.createObjectURL(blob);

    try {
      const transferableBytes = new Uint8Array(fileBytes.byteLength);
      transferableBytes.set(fileBytes);
      return await new Promise((resolve, reject) => {
        chrome.runtime.sendMessage(
          {
            type: 'bridge-browser-download',
            objectUrl,
            fileName,
            mimeType,
            fileBytes: transferableBytes.buffer,
          },
          (response) => {
          const runtimeError = chrome.runtime.lastError;
          if (runtimeError) {
            reject(new Error(runtimeError.message));
            return;
          }

          resolve((response ?? { ok: false, message: 'No response from background worker.' }) as {
            ok: boolean;
            savedPath?: string;
            message?: string;
          });
          }
        );
      });
    } finally {
      window.setTimeout(() => {
        URL.revokeObjectURL(objectUrl);
      }, 30_000);
    }
  }

  private async publishPopupStatus(): Promise<void> {
    try {
      const response = await new Promise<{
        ok: boolean;
        status?: {
          exists: boolean;
          state: 'open' | 'minimized' | 'closed' | 'unknown';
          tabId: number | null;
          pageUrl: string | null;
          updatedAt: string;
          textLength: number;
        };
        message?: string;
      }>((resolve, reject) => {
        chrome.runtime.sendMessage({ type: 'popup-status-get' }, (message) => {
          const runtimeError = chrome.runtime.lastError;
          if (runtimeError) {
            reject(new Error(runtimeError.message));
            return;
          }

          resolve((message ?? { ok: false }) as {
            ok: boolean;
            status?: {
              exists: boolean;
              state: 'open' | 'minimized' | 'closed' | 'unknown';
              tabId: number | null;
              pageUrl: string | null;
              updatedAt: string;
              textLength: number;
            };
            message?: string;
          });
        });
      });

      if (response.ok && response.status) {
        this.publishPopupStatusIfChanged(response.status);
      }
    } catch (error) {
      debugWarn('offscreen', 'Unable to publish popup status.', error);
    }
  }

  private publishPopupStatusIfChanged(status: {
    exists: boolean;
    state: 'open' | 'minimized' | 'closed' | 'unknown';
    tabId: number | null;
    pageUrl: string | null;
    updatedAt: string;
    textLength: number;
  }): void {
    const statusKey = JSON.stringify({
      exists: status.exists,
      state: status.state,
      tabId: status.tabId,
      pageUrl: status.pageUrl,
      textLength: status.textLength,
    });

    if (this.lastPublishedPopupStatusKey === statusKey) {
      debugLog('offscreen', 'Skipping duplicate popup status publish.', status);
      return;
    }

    this.lastPublishedPopupStatusKey = statusKey;
    this.sendOrQueueBridgeMessage({ type: 'popup.status', status });
  }

  private async publishPopupMessageHistory(): Promise<void> {
    try {
      const response = await new Promise<{
        ok: boolean;
        messages?: Array<{
          text?: string;
          pageUrl?: string | null;
          tabId?: number | null;
          sentAt?: string;
        }>;
      }>((resolve, reject) => {
        chrome.runtime.sendMessage({ type: 'popup-message-history-get' }, (message) => {
          const runtimeError = chrome.runtime.lastError;
          if (runtimeError) {
            reject(new Error(runtimeError.message));
            return;
          }

          resolve((message ?? { ok: false, messages: [] }) as {
            ok: boolean;
            messages?: Array<{
              text?: string;
              pageUrl?: string | null;
              tabId?: number | null;
              sentAt?: string;
            }>;
          });
        });
      });

      if (!response.ok || !Array.isArray(response.messages)) {
        return;
      }

      for (const message of [...response.messages].reverse()) {
        this.sendOrQueueBridgeMessage({
          type: 'popup.message',
          text: typeof message.text === 'string' ? message.text : '',
          pageUrl: typeof message.pageUrl === 'string' ? message.pageUrl : null,
          tabId: typeof message.tabId === 'number' ? message.tabId : null,
          sentAt: typeof message.sentAt === 'string' ? message.sentAt : new Date().toISOString()
        });
      }
    } catch (error) {
      debugWarn('offscreen', 'Unable to publish popup message history.', error);
    }
  }

  private async publishScreenShareStatus(): Promise<void> {
    try {
      const response = await new Promise<{
        ok: boolean;
        status?: {
          state: 'idle' | 'launching' | 'active' | 'ended' | 'error';
          active: boolean;
          viewerWindowId: number | null;
          sourceLabel: string | null;
          updatedAt: string;
          message: string;
        };
      }>((resolve, reject) => {
        chrome.runtime.sendMessage({ type: 'screen-share-status-get' }, (message) => {
          const runtimeError = chrome.runtime.lastError;
          if (runtimeError) {
            reject(new Error(runtimeError.message));
            return;
          }

          resolve((message ?? { ok: false }) as {
            ok: boolean;
            status?: {
              state: 'idle' | 'launching' | 'active' | 'ended' | 'error';
              active: boolean;
              viewerWindowId: number | null;
              sourceLabel: string | null;
              updatedAt: string;
              message: string;
            };
          });
        });
      });

      if (response.ok && response.status) {
        this.sendOrQueueBridgeMessage({ type: 'screen-share.status', status: response.status });
      }
    } catch (error) {
      debugWarn('offscreen', 'Unable to publish screen share status.', error);
    }
  }

  private send(message: BridgeOutboundMessage): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      debugWarn('offscreen', 'Skipping websocket send because socket is not open.', message.type);
      return;
    }

    debugLog('offscreen', 'Sending websocket message.', message.type);
    this.socket.send(JSON.stringify(message));
  }

  private sendOrQueueBridgeMessage(message: BridgeOutboundMessage): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      debugLog('offscreen', 'Queueing bridge message until websocket is open.', message.type);
      this.pendingBridgeMessages.push(message);
      if (this.pendingBridgeMessages.length > 20) {
        this.pendingBridgeMessages.splice(0, this.pendingBridgeMessages.length - 20);
      }
      return;
    }

    this.send(message);
  }

  private sendOrQueueBinaryCaptureResult(requestId: string, capturedPage: CapturedPage): void {
    const queuedMessage: QueuedBridgeMessage = {
      type: 'capture.result.binary',
      requestId,
      capturedPage,
    };

    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      debugLog('offscreen', 'Queueing binary capture result until websocket is open.', {
        requestId,
        fileName: capturedPage.fileName,
      });
      this.pendingBridgeMessages.push(queuedMessage);
      if (this.pendingBridgeMessages.length > 20) {
        this.pendingBridgeMessages.splice(0, this.pendingBridgeMessages.length - 20);
      }
      return;
    }

    this.sendBinaryCaptureResult(requestId, capturedPage);
  }

  private flushPendingBridgeMessages(): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN || this.pendingBridgeMessages.length === 0) {
      return;
    }

    const queuedMessages = [...this.pendingBridgeMessages];
    this.pendingBridgeMessages = [];
    for (const message of queuedMessages) {
      if (message.type === 'capture.result.binary') {
        this.sendBinaryCaptureResult(message.requestId, message.capturedPage);
        continue;
      }

      this.send(message);
    }
  }

  private sendBinaryCaptureResult(requestId: string, capturedPage: CapturedPage): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      debugWarn('offscreen', 'Skipping binary capture send because socket is not open.', requestId);
      return;
    }

    const imageBytes = this.base64ToBytes(capturedPage.base64Data);
    const metadataBytes = new TextEncoder().encode(
      JSON.stringify({
        type: 'capture.result.binary',
        requestId,
        capturedPage: {
          tab: capturedPage.tab,
          mimeType: capturedPage.mimeType,
          fileName: capturedPage.fileName,
          capturedAt: capturedPage.capturedAt,
          widthCssPx: capturedPage.widthCssPx,
          heightCssPx: capturedPage.heightCssPx,
          scale: capturedPage.scale,
        },
      })
    );
    const envelope = new Uint8Array(4 + metadataBytes.length + imageBytes.length);
    const view = new DataView(envelope.buffer);
    view.setUint32(0, metadataBytes.length);
    envelope.set(metadataBytes, 4);
    envelope.set(imageBytes, 4 + metadataBytes.length);
    debugLog('offscreen', 'Sending binary capture result.', {
      requestId,
      fileName: capturedPage.fileName,
      bytes: imageBytes.length,
      metadataBytes: metadataBytes.length,
    });
    this.socket.send(envelope.buffer);
  }

  private sendPopupFileUpload(metadata: PopupFileBinaryMessage, fileBytes: Uint8Array): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error('The desktop bridge is not connected. Reconnect the GUI bridge before sending files from the popup.');
    }

    const metadataBytes = new TextEncoder().encode(JSON.stringify(metadata));
    const envelope = new Uint8Array(4 + metadataBytes.length + fileBytes.length);
    const view = new DataView(envelope.buffer);
    view.setUint32(0, metadataBytes.length);
    envelope.set(metadataBytes, 4);
    envelope.set(fileBytes, 4 + metadataBytes.length);
    debugLog('offscreen', 'Sending popup-uploaded file to desktop bridge.', {
      uploadId: metadata.uploadId,
      fileName: metadata.fileName,
      bytes: fileBytes.length,
      pageUrl: metadata.pageUrl,
      tabId: metadata.tabId,
    });
    this.socket.send(envelope.buffer);
  }

  private base64ToBytes(base64Data: string): Uint8Array {
    const normalizedBase64 = base64Data.replace(/\s+/g, '');
    const binaryString = atob(normalizedBase64);
    const bytes = new Uint8Array(binaryString.length);
    for (let index = 0; index < binaryString.length; index += 1) {
      bytes[index] = binaryString.charCodeAt(index);
    }

    return bytes;
  }

  private async writeClipboardText(text: string): Promise<void> {
    if (typeof text !== 'string') {
      throw new Error('Clipboard payload must be a string.');
    }

    if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
      try {
        await navigator.clipboard.write([
          new ClipboardItem({
            'text/plain': new Blob([text], { type: 'text/plain' })
          })
        ]);
        return;
      } catch (error) {
        debugWarn('offscreen', 'ClipboardItem write failed; falling back to writeText.', error);
      }
    }

    if (navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(text);
        return;
      } catch (error) {
        debugWarn('offscreen', 'navigator.clipboard.writeText failed; falling back to execCommand.', error);
      }
    }

    if (this.copyWithTextarea(text)) {
      return;
    }

    if (this.copyWithContentEditable(text)) {
      return;
    }

    throw new Error('All clipboard write strategies failed in the offscreen document.');
  }

  private copyWithTextarea(text: string): boolean {
    const container = document.body ?? document.documentElement;
    if (!container) {
      return false;
    }

    const activeElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', 'true');
    textarea.setAttribute('aria-hidden', 'true');
    textarea.style.position = 'fixed';
    textarea.style.top = '0';
    textarea.style.left = '0';
    textarea.style.width = '1px';
    textarea.style.height = '1px';
    textarea.style.opacity = '0';
    textarea.style.pointerEvents = 'none';
    textarea.style.zIndex = '-1';
    container.appendChild(textarea);

    try {
      textarea.focus();
      textarea.select();
      textarea.setSelectionRange(0, textarea.value.length);
      return document.execCommand('copy');
    } catch {
      return false;
    } finally {
      textarea.remove();
      activeElement?.focus({ preventScroll: true });
    }
  }

  private copyWithContentEditable(text: string): boolean {
    const container = document.body ?? document.documentElement;
    if (!container) {
      return false;
    }

    const selection = window.getSelection();
    const existingRanges = selection ? Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index).cloneRange()) : [];
    const activeElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;

    const editable = document.createElement('div');
    editable.contentEditable = 'true';
    editable.setAttribute('aria-hidden', 'true');
    editable.style.position = 'fixed';
    editable.style.top = '0';
    editable.style.left = '0';
    editable.style.opacity = '0';
    editable.style.pointerEvents = 'none';
    editable.style.whiteSpace = 'pre-wrap';
    editable.textContent = text;
    container.appendChild(editable);

    try {
      const range = document.createRange();
      range.selectNodeContents(editable);
      selection?.removeAllRanges();
      selection?.addRange(range);
      editable.focus();
      return document.execCommand('copy');
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

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== null) {
      return;
    }

    debugLog('offscreen', 'Scheduling reconnect.', BRIDGE_RECONNECT_INTERVAL_MS);
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      void this.start(true);
    }, BRIDGE_RECONNECT_INTERVAL_MS);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private async closeConnection(message: string): Promise<void> {
    debugLog('offscreen', 'Closing bridge connection.', message);
    this.clearReconnectTimer();
    this.disposeActiveSocket();

    await this.updateStatus({
      state: 'disconnected',
      updatedAt: new Date().toISOString(),
      message,
      lastFileName: null,
      targetUrl: this.resolvedTargetUrl ?? this.currentSettings?.websocketUrl ?? null
    });
  }

  private async resolveEndpoint(settings: ExtensionSettings, settingsChanged: boolean): Promise<ResolvedBridgeEndpoint> {
    // ----- Relay mode: cycle relay -> local x3 -> relay x1 -> repeat. -----
    if (settings.connectionMode === 'relay') {
      const relayUrl = (settings.relayUrl || '').trim();
      if (!relayUrl) {
        // Misconfigured: relay mode chosen but no URL set. Fall back to local so
        // the user can see the failure surfaced in the UI.
        return { targetUrl: settings.websocketUrl, source: 'direct', resolverUrl: null };
      }
      if (settingsChanged) {
        this.relayCycleStep = 0;
      }
      const step = this.relayCycleStep % 5;
      // Steps 1, 2, 3 -> try local; steps 0 and 4 -> try relay.
      if (step >= 1 && step <= 3) {
        this.nextEndpointMode = 'direct';
        return { targetUrl: settings.websocketUrl, source: 'direct', resolverUrl: null };
      }
      this.nextEndpointMode = 'relay';
      return { targetUrl: relayUrl, source: 'direct', resolverUrl: null };
    }

    const hasResolver = Boolean(settings.websocketResolverUrl);
    const relayUrl = (settings.relayUrl || '').trim();
    const allowRelayFallback = settings.connectionMode === 'auto' && Boolean(relayUrl);

    if (!hasResolver) {
      // Auto mode with no resolver but a relay URL: still allow relay as a last resort.
      if (this.nextEndpointMode === 'relay' && allowRelayFallback) {
        return { targetUrl: relayUrl, source: 'direct', resolverUrl: null };
      }
      return {
        targetUrl: settings.websocketUrl,
        source: 'direct',
        resolverUrl: null
      };
    }

    if (settingsChanged) {
      this.nextEndpointMode = 'pastebin';
      this.localRetryAttempts = 0;
    }

    if (this.nextEndpointMode === 'relay' && allowRelayFallback) {
      return { targetUrl: relayUrl, source: 'direct', resolverUrl: null };
    }

    if (this.nextEndpointMode === 'direct') {
      return {
        targetUrl: settings.websocketUrl,
        source: 'direct',
        resolverUrl: null
      };
    }

    const resolverUrl = this.nextEndpointMode === 'pastebin'
      ? settings.websocketResolverUrl || DEFAULT_WEBSOCKET_RESOLVER_URL
      : DEFAULT_WEBSOCKET_SECONDARY_RESOLVER_URL;

    try {
      const endpoint = await resolveBridgeEndpoint(settings.websocketUrl, resolverUrl);
      debugLog('offscreen', 'Resolved bridge endpoint.', endpoint);

      if (this.resolvedEndpoint && this.resolvedEndpoint.targetUrl !== endpoint.targetUrl) {
        await this.updateStatus({
          state: 'connecting',
          updatedAt: new Date().toISOString(),
          message: `Resolver updated bridge target from ${this.resolvedEndpoint.targetUrl} to ${endpoint.targetUrl}.`,
          lastFileName: null,
          targetUrl: endpoint.targetUrl
        });
      }

      return endpoint;
    } catch (error) {
      const messageText = error instanceof Error ? error.message : 'Unknown resolver failure.';
      debugWarn('offscreen', 'Resolver failed; using fallback endpoint.', messageText);

      if (this.nextEndpointMode === 'pastebin') {
        this.nextEndpointMode = 'github';
      } else {
        this.nextEndpointMode = 'direct';
        this.localRetryAttempts = 0;
      }

      const fallbackEndpoint = {
        targetUrl: settings.websocketUrl,
        source: 'direct' as const,
        resolverUrl: null
      };

      await this.updateStatus({
        state: 'disconnected',
        updatedAt: new Date().toISOString(),
        message: `Resolver failed: ${messageText}. Continuing with ${fallbackEndpoint.targetUrl}.`,
        lastFileName: null,
        targetUrl: fallbackEndpoint.targetUrl
      });

      return fallbackEndpoint;
    }
  }

  private recordFailedAttempt(source: ResolvedBridgeEndpoint['source']): void {
    const settings = this.currentSettings;
    const allowRelayFallback =
      settings?.connectionMode === 'auto' && Boolean((settings?.relayUrl || '').trim());

    // Relay mode: advance the relay->local x3->relay cycle.
    if (settings?.connectionMode === 'relay') {
      this.relayCycleStep = (this.relayCycleStep + 1) % 5;
      return;
    }

    if (this.nextEndpointMode === 'relay') {
      // Relay also failed: cycle back to pastebin (auto) or stick (relay-only).
      if (settings?.connectionMode === 'relay') {
        return; // stay in relay mode; relay client retries on its own.
      }
      this.nextEndpointMode = 'pastebin';
      this.localRetryAttempts = 0;
      return;
    }

    if (source === 'resolver') {
      if (this.nextEndpointMode === 'pastebin') {
        this.nextEndpointMode = 'github';
        return;
      }

      this.nextEndpointMode = 'direct';
      this.localRetryAttempts = 0;
      return;
    }

    this.localRetryAttempts += 1;
    if (this.localRetryAttempts >= BRIDGE_RESOLVER_REFRESH_FAILURE_THRESHOLD) {
      // Auto mode with a relay configured: try relay before looping back to pastebin.
      this.nextEndpointMode = allowRelayFallback ? 'relay' : 'pastebin';
      this.localRetryAttempts = 0;
      return;
    }

    this.nextEndpointMode = 'direct';
  }

  private buildReconnectHint(): string {
    if (!this.currentSettings?.websocketResolverUrl) {
      return '';
    }

    if (this.nextEndpointMode === 'pastebin') {
      return ' Next attempt will refresh the Pastebin resolver target.';
    }

    if (this.nextEndpointMode === 'github') {
      return ' Next attempt will try the GitHub raw resolver target.';
    }

    const remainingLocalAttempts = BRIDGE_RESOLVER_REFRESH_FAILURE_THRESHOLD - this.localRetryAttempts;
    return ` Next attempt will retry localhost. ${remainingLocalAttempts} local attempt${remainingLocalAttempts === 1 ? '' : 's'} remain before Pastebin is checked again.`;
  }

  private invalidateResolvedEndpoint(): void {
    debugLog('offscreen', 'Invalidating resolved endpoint cache.');
    this.resolvedEndpoint = null;
    this.resolvedTargetUrl = null;
    this.consecutiveConnectionFailures = 0;
    this.nextEndpointMode = 'pastebin';
    this.localRetryAttempts = 0;
  }

  private disposeActiveSocket(): void {
    if (!this.socket) {
      return;
    }

    debugLog('offscreen', 'Disposing active websocket socket.');
    this.connectionGeneration += 1;
    this.socket.close();
    this.socket = null;
  }

  private async updateStatus(status: CaptureRunStatus): Promise<void> {
    try {
      await this.runStatusRepository.save(status);
    } catch (error) {
      debugWarn('offscreen', 'Failed to persist offscreen bridge status.', error);
    }
  }

  private registerRuntimeListeners(): void {
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      debugLog('offscreen', 'Received runtime message.', message?.type ?? 'unknown');
      if (message?.type === 'bridge-start') {
        void this.start(false)
          .then(() => sendResponse({ ok: true }))
          .catch((error) => {
            const messageText = error instanceof Error ? error.message : 'Bridge startup failed.';
            debugError('offscreen', 'Bridge start request failed.', messageText);
            sendResponse({ ok: false, message: messageText });
          });
        return true;
      }

      if (message?.type === 'bridge-reconnect') {
        void this.start(true)
          .then(() => sendResponse({ ok: true }))
          .catch((error) => {
            const messageText = error instanceof Error ? error.message : 'Bridge reconnect failed.';
            debugError('offscreen', 'Bridge reconnect request failed.', messageText);
            sendResponse({ ok: false, message: messageText });
          });
        return true;
      }

      if (message?.type === 'popup-status-changed') {
        debugLog('offscreen', 'Received popup status update from background.', message.status);
        if (message.status) {
          this.publishPopupStatusIfChanged(message.status);
        }
        sendResponse({ ok: true });
        return true;
      }

      if (message?.type === 'popup-page-message') {
        const payload = {
          text: typeof message.payload?.text === 'string' ? message.payload.text : '',
          pageUrl: typeof message.payload?.pageUrl === 'string' ? message.payload.pageUrl : null,
          tabId: typeof message.payload?.tabId === 'number' ? message.payload.tabId : null,
          sentAt: typeof message.payload?.sentAt === 'string' ? message.payload.sentAt : new Date().toISOString()
        };
        debugLog('offscreen', 'Forwarding popup text message to desktop bridge.', {
          tabId: payload.tabId,
          pageUrl: payload.pageUrl,
          characters: payload.text.length
        });
        this.sendOrQueueBridgeMessage({ type: 'popup.message', ...payload });
        sendResponse({ ok: true });
        return true;
      }

      if (message?.type === 'popup-file-upload') {
        try {
          const fileName = typeof message.payload?.fileName === 'string' && message.payload.fileName.trim()
            ? message.payload.fileName.trim()
            : 'client-upload.bin';
          const mimeType = typeof message.payload?.mimeType === 'string' && message.payload.mimeType.trim()
            ? message.payload.mimeType.trim()
            : 'application/octet-stream';
          const rawBytes = message.payload?.fileBytes;
          const base64Bytes = typeof message.payload?.fileBytesBase64 === 'string'
            ? message.payload.fileBytesBase64
            : '';
          let fileBytes: Uint8Array | null = null;
          if (base64Bytes) {
            fileBytes = decodeBase64ToBytes(base64Bytes);
          } else if (rawBytes instanceof ArrayBuffer) {
            fileBytes = new Uint8Array(rawBytes);
          } else if (rawBytes instanceof Uint8Array) {
            fileBytes = rawBytes;
          }
          if (fileBytes === null) {
            throw new Error('Popup file upload did not include a valid binary payload.');
          }
          debugLog('offscreen', 'Decoded popup file upload; sending envelope to bridge.', {
            fileName,
            mimeType,
            bytes: fileBytes.length,
            socketReady: this.socket?.readyState === WebSocket.OPEN,
          });

          this.sendPopupFileUpload(
            {
              type: 'popup-file.binary',
              uploadId: typeof message.payload?.uploadId === 'string' && message.payload.uploadId
                ? message.payload.uploadId
                : crypto.randomUUID(),
              fileName,
              mimeType,
              byteCount: typeof message.payload?.byteCount === 'number' ? message.payload.byteCount : fileBytes.byteLength,
              pageUrl: typeof message.payload?.pageUrl === 'string' ? message.payload.pageUrl : null,
              tabId: typeof message.payload?.tabId === 'number' ? message.payload.tabId : null,
              sentAt: typeof message.payload?.sentAt === 'string' && message.payload.sentAt
                ? message.payload.sentAt
                : new Date().toISOString(),
              text: typeof message.payload?.text === 'string' ? message.payload.text : '',
            },
            fileBytes,
          );
          sendResponse({ ok: true, message: `${fileName} queued for delivery to the desktop control center.` });
        } catch (error) {
          const messageText = error instanceof Error ? error.message : 'Popup file upload failed.';
          debugError('offscreen', 'Popup file upload request failed.', messageText);
          sendResponse({ ok: false, message: messageText });
        }
        return true;
      }

      if (message?.type === 'screen-share-status-changed') {
        debugLog('offscreen', 'Received screen share status update from background.', message.status);
        if (message.status) {
          this.sendOrQueueBridgeMessage({ type: 'screen-share.status', status: message.status });
        }
        sendResponse({ ok: true });
        return true;
      }

      return false;
    });

    const storageOnChanged = chrome.storage?.onChanged;
    if (storageOnChanged?.addListener) {
      storageOnChanged.addListener((changes, areaName) => {
        if (areaName === 'sync' && changes[SETTINGS_STORAGE_KEY]) {
          debugLog('offscreen', 'Observed storage change for settings; restarting bridge.');
          void this.start(true).catch((error) => {
            debugWarn('offscreen', 'Bridge restart after settings change failed.', error);
          });
        }
      });
    }
  }
}

const bridgeClient = new ExtensionBridgeClient();

void bridgeClient.start(false).catch((error) => {
  debugError('offscreen', 'Initial offscreen bridge startup failed.', error);
});
