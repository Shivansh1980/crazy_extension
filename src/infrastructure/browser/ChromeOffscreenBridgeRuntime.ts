import type { BridgeRuntime } from '../../domain/ports/BridgeRuntime';
import { getBrowserCapabilities } from '../../shared/browserCapabilities';
import { OFFSCREEN_DOCUMENT_PATH } from '../../shared/constants';
import { ExtensionError } from '../../shared/errors';

export class ChromeOffscreenBridgeRuntime implements BridgeRuntime {
  private creatingDocumentPromise: Promise<void> | null = null;

  async ensureStarted(): Promise<void> {
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

  async ensureConnected(): Promise<void> {
    const capabilities = getBrowserCapabilities();
    if (!capabilities.runtimeMessaging) {
      throw new ExtensionError('This browser does not support extension runtime messaging required for bridge startup.');
    }

    // bridge-start is idempotent: offscreen will only open a new socket if the existing one
    // is closed. Crucially, this does NOT force-replace a healthy socket, so callers like the
    // popup file send can safely call this without dropping any in-flight binary frames.
    await this.sendBridgeMessage('bridge-start');
  }

  async reconnect(): Promise<void> {
    const capabilities = getBrowserCapabilities();
    if (!capabilities.runtimeMessaging) {
      throw new ExtensionError('This browser does not support extension runtime messaging required for bridge reconnect.');
    }

    await this.sendBridgeMessage('bridge-reconnect');
  }

  private async createDocument(): Promise<void> {
    const capabilities = getBrowserCapabilities();
    if (!capabilities.offscreenDocument) {
      throw new ExtensionError('This browser does not support offscreen documents required for the desktop bridge.');
    }

    try {
      if (typeof chrome.offscreen.hasDocument === 'function' && await chrome.offscreen.hasDocument()) {
        return;
      }
      await chrome.offscreen.createDocument({
        url: OFFSCREEN_DOCUMENT_PATH,
        reasons: [chrome.offscreen.Reason.BLOBS, chrome.offscreen.Reason.CLIPBOARD],
        justification: 'Maintain a resilient local WebSocket bridge for desktop-driven screenshot capture and clipboard sync.'
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      const normalizedMessage = message.toLowerCase();
      if (!normalizedMessage.includes('single offscreen') && !normalizedMessage.includes('already exists')) {
        throw new ExtensionError(message || 'Unable to create the offscreen bridge document.');
      }
    }
  }

  private async sendBridgeMessage(type: 'bridge-start' | 'bridge-reconnect'): Promise<void> {
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      try {
        const response = await chrome.runtime.sendMessage({ type });
        if (!response?.ok) {
          throw new ExtensionError(response?.message ?? `The offscreen document rejected ${type}.`);
        }
        return;
      } catch (error) {
        lastError = error;
        const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
        const listenerIsStarting = message.includes('receiving end does not exist') || message.includes('message port closed');
        if (!listenerIsStarting || attempt === 5) {
          break;
        }
        await new Promise<void>((resolve) => setTimeout(resolve, attempt * 100));
      }
    }

    if (lastError instanceof ExtensionError) {
      throw lastError;
    }
    const message = lastError instanceof Error ? lastError.message : String(lastError ?? '');
    throw new ExtensionError(message || `Unable to deliver ${type} to the offscreen bridge.`);
  }
}
