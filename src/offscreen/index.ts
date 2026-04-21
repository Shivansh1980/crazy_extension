import type { CapturedPage } from '../domain/models/CapturedPage';
import type { CaptureRunStatus } from '../domain/models/CaptureRunStatus';
import type { ExtensionSettings } from '../domain/models/ExtensionSettings';
import { ChromeRunStatusRepository } from '../infrastructure/storage/ChromeRunStatusRepository';
import { ChromeSettingsRepository } from '../infrastructure/storage/ChromeSettingsRepository';
import { resolveBridgeEndpoint, type ResolvedBridgeEndpoint } from '../shared/bridgeUrlResolver';
import {
  BRIDGE_CLIENT_NAME,
  BRIDGE_RECONNECT_INTERVAL_MS,
  BRIDGE_RESOLVER_REFRESH_FAILURE_THRESHOLD,
  SETTINGS_STORAGE_KEY
} from '../shared/constants';

type BridgeInboundMessage = {
  type: 'capture.request';
  requestId: string;
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

  constructor() {
    this.registerRuntimeListeners();
  }

  async start(forceReconnect = false): Promise<void> {
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

      this.send({
        type: 'client.register',
        clientId: this.clientId,
        name: BRIDGE_CLIENT_NAME,
        version: chrome.runtime.getManifest().version,
        capabilities: ['capture.full-page']
      });

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
      void this.handleMessage(event.data, endpoint.targetUrl, settings, generation);
    });

    socket.addEventListener('error', () => {
      socket.close();
    });

    socket.addEventListener('close', () => {
      if (generation !== this.connectionGeneration) {
        return;
      }

      this.socket = null;
      this.consecutiveConnectionFailures += 1;
      const refreshHint =
        this.shouldRefreshResolver()
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
      return;
    }

    if (message.type !== 'capture.request') {
      return;
    }

    try {
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

      this.send({
        type: 'capture.result',
        requestId: message.requestId,
        capturedPage: response.capturedPage
      });
    } catch (error) {
      const messageText = error instanceof Error ? error.message : 'Capture request failed.';
      await this.updateStatus({
        state: 'error',
        updatedAt: new Date().toISOString(),
        message: messageText,
        lastFileName: null,
        targetUrl
      });
      this.send({
        type: 'capture.error',
        requestId: message.requestId,
        message: messageText
      });
    }
  }

  private async requestCapture(settings: ExtensionSettings): Promise<{ ok: boolean; capturedPage?: CapturedPage; message?: string }> {
    return new Promise((resolve, reject) => {
      const timeoutHandle = window.setTimeout(() => {
        reject(new Error(`Capture request timed out after ${settings.requestTimeoutMs}ms.`));
      }, settings.requestTimeoutMs);

      chrome.runtime.sendMessage({ type: 'bridge-capture-request' }, (response) => {
        clearTimeout(timeoutHandle);

        const runtimeError = chrome.runtime.lastError;
        if (runtimeError) {
          reject(new Error(runtimeError.message));
          return;
        }

        resolve((response ?? { ok: false, message: 'No response from background worker.' }) as {
          ok: boolean;
          capturedPage?: CapturedPage;
          message?: string;
        });
      });
    });
  }

  private send(message: BridgeOutboundMessage): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return;
    }

    this.socket.send(JSON.stringify(message));
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== null) {
      return;
    }

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
    const shouldRefreshResolver = settingsChanged || this.resolvedEndpoint === null || this.shouldRefreshResolver();

    if (!shouldRefreshResolver && this.resolvedEndpoint) {
      return this.resolvedEndpoint;
    }

    try {
      const endpoint = await resolveBridgeEndpoint(settings.websocketUrl, settings.websocketResolverUrl);

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

  private shouldRefreshResolver(): boolean {
    return (
      Boolean(this.currentSettings?.websocketResolverUrl) &&
      this.consecutiveConnectionFailures > 0 &&
      this.consecutiveConnectionFailures % BRIDGE_RESOLVER_REFRESH_FAILURE_THRESHOLD === 0
    );
  }

  private invalidateResolvedEndpoint(): void {
    this.resolvedEndpoint = null;
    this.resolvedTargetUrl = null;
    this.consecutiveConnectionFailures = 0;
  }

  private disposeActiveSocket(): void {
    if (!this.socket) {
      return;
    }

    this.connectionGeneration += 1;
    this.socket.close();
    this.socket = null;
  }

  private async updateStatus(status: CaptureRunStatus): Promise<void> {
    try {
      await this.runStatusRepository.save(status);
    } catch (error) {
      console.warn('Failed to persist offscreen bridge status.', error);
    }
  }

  private registerRuntimeListeners(): void {
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (message?.type === 'bridge-start') {
        void this.start(false)
          .then(() => sendResponse({ ok: true }))
          .catch((error) => {
            const messageText = error instanceof Error ? error.message : 'Bridge startup failed.';
            sendResponse({ ok: false, message: messageText });
          });
        return true;
      }

      if (message?.type === 'bridge-reconnect') {
        void this.start(true)
          .then(() => sendResponse({ ok: true }))
          .catch((error) => {
            const messageText = error instanceof Error ? error.message : 'Bridge reconnect failed.';
            sendResponse({ ok: false, message: messageText });
          });
        return true;
      }

      return false;
    });

    const storageOnChanged = chrome.storage?.onChanged;
    if (storageOnChanged?.addListener) {
      storageOnChanged.addListener((changes, areaName) => {
        if (areaName === 'sync' && changes[SETTINGS_STORAGE_KEY]) {
          void this.start(true).catch((error) => {
            console.warn('Bridge restart after settings change failed.', error);
          });
        }
      });
    }
  }
}

const bridgeClient = new ExtensionBridgeClient();

void bridgeClient.start(false).catch((error) => {
  console.error('Initial offscreen bridge startup failed.', error);
});
