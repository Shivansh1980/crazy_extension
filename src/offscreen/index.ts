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
  SETTINGS_STORAGE_KEY
} from '../shared/constants';

type BridgeInboundMessage =
  | {
      type: 'capture.request';
      requestId: string;
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
    };

type BridgeOutboundMessage =
  | {
      type: 'client.register';
      clientId: string;
      name: string;
      version: string;
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
    };

type QueuedBridgeMessage =
  | BridgeOutboundMessage
  | {
      type: 'capture.result.binary';
      requestId: string;
      capturedPage: CapturedPage;
    };

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
    this.socket = socket;

    socket.addEventListener('open', () => {
      if (generation !== this.connectionGeneration) {
        socket.close();
        return;
      }

      this.consecutiveConnectionFailures = 0;
      this.hasConnectedOnce = true;
      debugLog('offscreen', 'running...');
      debugLog('offscreen', 'WebSocket connection opened.', endpoint.targetUrl);

      this.send({
        type: 'client.register',
        clientId: this.clientId,
        name: BRIDGE_CLIENT_NAME,
        version: __EXTENSION_VERSION__,
        capabilities: ['capture.full-page']
      });
      this.flushPendingBridgeMessages();
      void this.publishPopupStatus();
      void this.publishPopupMessageHistory();

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
      const closeDetails = {
        targetUrl: endpoint.targetUrl,
        code: event.code,
        reason: event.reason || null,
        wasClean: event.wasClean,
        previouslyConnected: this.hasConnectedOnce,
        consecutiveConnectionFailures: this.consecutiveConnectionFailures
      };

      if (this.hasConnectedOnce && event.code !== 1000) {
        debugWarn('offscreen', 'WebSocket connection closed unexpectedly.', closeDetails);
      } else {
        debugLog('offscreen', 'WebSocket connection closed; reconnect will be attempted.', closeDetails);
      }

      const refreshHint = this.currentSettings?.websocketResolverUrl
        ? ' Refreshing the resolver URL on the next attempt.'
        : '';

      void this.updateStatus({
        state: 'disconnected',
        updatedAt: new Date().toISOString(),
        message: `Bridge connection closed. Retrying ${endpoint.targetUrl} in 5 seconds. Failure count: ${this.consecutiveConnectionFailures}.${refreshHint}`,
        lastFileName: null,
        targetUrl: endpoint.targetUrl
      });
      this.scheduleReconnect();
    });
  }

  private async handleMessage(
    rawData: string | ArrayBuffer,
    targetUrl: string,
    settings: ExtensionSettings,
    generation: number
  ): Promise<void> {
    if (generation !== this.connectionGeneration) {
      return;
    }

    const payload = typeof rawData === 'string' ? rawData : new TextDecoder().decode(rawData);
    let message: BridgeInboundMessage;

    try {
      message = JSON.parse(payload) as BridgeInboundMessage;
    } catch {
      debugWarn('offscreen', 'Ignoring non-JSON websocket payload.');
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
    const shouldRefreshResolver =
      settingsChanged ||
      this.resolvedEndpoint === null ||
      Boolean(settings.websocketResolverUrl);

    if (!shouldRefreshResolver && this.resolvedEndpoint) {
      return this.resolvedEndpoint;
    }

    try {
      const endpoint = await resolveBridgeEndpoint(settings.websocketUrl, settings.websocketResolverUrl);
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
      const fallbackEndpoint = this.resolvedEndpoint ?? {
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

  private invalidateResolvedEndpoint(): void {
    debugLog('offscreen', 'Invalidating resolved endpoint cache.');
    this.resolvedEndpoint = null;
    this.resolvedTargetUrl = null;
    this.consecutiveConnectionFailures = 0;
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
