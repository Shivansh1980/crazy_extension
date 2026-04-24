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

  async reconnect(): Promise<void> {
    const capabilities = getBrowserCapabilities();
    if (!capabilities.runtimeMessaging) {
      throw new ExtensionError('This browser does not support extension runtime messaging required for bridge reconnect.');
    }

    await chrome.runtime.sendMessage({ type: 'bridge-start' }).catch(() => undefined);
    await chrome.runtime.sendMessage({ type: 'bridge-reconnect' }).catch(() => undefined);
  }

  private async createDocument(): Promise<void> {
    const capabilities = getBrowserCapabilities();
    if (!capabilities.offscreenDocument) {
      throw new ExtensionError('This browser does not support offscreen documents required for the desktop bridge.');
    }

    try {
      await chrome.offscreen.createDocument({
        url: OFFSCREEN_DOCUMENT_PATH,
        reasons: [chrome.offscreen.Reason.BLOBS, chrome.offscreen.Reason.CLIPBOARD],
        justification: 'Maintain a resilient local WebSocket bridge for desktop-driven screenshot capture and clipboard sync.'
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      if (!message.includes('Only a single offscreen document may be created')) {
        throw new ExtensionError(message || 'Unable to create the offscreen bridge document.');
      }
    }
  }
}
