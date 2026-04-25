import type { BrowserTab } from '../../domain/models/BrowserTab';
import type { CapturedPage } from '../../domain/models/CapturedPage';
import type { ExtensionSettings } from '../../domain/models/ExtensionSettings';
import type { FullPageCaptureGateway } from '../../domain/ports/FullPageCaptureGateway';
import { getBrowserCapabilities } from '../../shared/browserCapabilities';
import { MAX_CAPTURE_AREA, MAX_CAPTURE_DIMENSION } from '../../shared/constants';
import { ExtensionError } from '../../shared/errors';
import { buildCaptureFileName } from '../../shared/fileName';
import { ChromeDebuggerClient } from './ChromeDebuggerClient';

interface LayoutMetricsResult {
  contentSize: {
    width: number;
    height: number;
    x: number;
    y: number;
  };
}

interface CaptureScreenshotResult {
  data: string;
}

export class ChromeFullPageCaptureGateway implements FullPageCaptureGateway {
  constructor(private readonly debuggerClient: ChromeDebuggerClient) {}

  async capture(tab: BrowserTab, settings: ExtensionSettings): Promise<CapturedPage> {
    const debuggee: chrome.debugger.Debuggee = { tabId: tab.id };
    await this.debuggerClient.attach(debuggee);

    let viewportOverridden = false;
    try {
      await this.debuggerClient.sendCommand(debuggee, 'Page.enable');
      const layoutMetrics = await this.debuggerClient.sendCommand<LayoutMetricsResult>(debuggee, 'Page.getLayoutMetrics');
      const devicePixelRatio = await this.readDevicePixelRatio(tab.id);

      const widthCssPx = Math.max(1, Math.ceil(layoutMetrics.contentSize.width));
      const heightCssPx = Math.max(1, Math.ceil(layoutMetrics.contentSize.height));
      const scale = this.computeCaptureScale(widthCssPx, heightCssPx, devicePixelRatio);

      // Resize the emulated viewport to cover the entire scrollable content. This is the
      // canonical CDP pattern for clean full-page screenshots: it forces the page to lay out
      // every fixed/sticky/virtualized element as if it were the only viewport, so we get a
      // single render with no duplicated headers, no tiled segments, and no missing
      // virtualized rows. The previous `captureBeyondViewport: true` shortcut paints fixed
      // elements at their viewport coordinates inside the expanded layout, which produces
      // the "repeated header / repeated frame" appearance on many real-world pages.
      await this.debuggerClient.sendCommand(debuggee, 'Emulation.setDeviceMetricsOverride', {
        width: widthCssPx,
        height: heightCssPx,
        deviceScaleFactor: devicePixelRatio,
        mobile: false,
      });
      viewportOverridden = true;

      // Give the page a single animation-frame to relayout under the new viewport. This is
      // a small wait but eliminates a race where the screenshot is taken before the page
      // has reflowed (which can clip footers / produce gray bands at the bottom).
      await this.waitForRelayout(tab.id);

      const result = await this.debuggerClient.sendCommand<CaptureScreenshotResult>(debuggee, 'Page.captureScreenshot', {
        format: 'png',
        fromSurface: true,
        captureBeyondViewport: false,
        clip: {
          x: 0,
          y: 0,
          width: widthCssPx,
          height: heightCssPx,
          scale,
        },
      });

      const capturedAt = new Date().toISOString();

      return {
        tab,
        base64Data: result.data,
        mimeType: 'image/png',
        fileName: buildCaptureFileName(settings.fileNamePrefix, capturedAt),
        capturedAt,
        widthCssPx,
        heightCssPx,
        scale
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown screenshot failure.';
      throw new ExtensionError(`Full-page capture failed: ${message}`);
    } finally {
      if (viewportOverridden) {
        await this.debuggerClient
          .sendCommand(debuggee, 'Emulation.clearDeviceMetricsOverride')
          .catch(() => undefined);
      }
      await this.debuggerClient.detach(debuggee).catch(() => undefined);
    }
  }

  private async waitForRelayout(tabId: number): Promise<void> {
    const capabilities = getBrowserCapabilities();
    if (!capabilities.scriptingApi) {
      return;
    }

    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        func: () =>
          new Promise<void>((resolve) => {
            requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
          }),
      });
    } catch {
      // Best-effort wait; if the page rejects the script, fall through to capture immediately.
    }
  }

  private async readDevicePixelRatio(tabId: number): Promise<number> {
    const capabilities = getBrowserCapabilities();
    if (!capabilities.scriptingApi) {
      throw new ExtensionError('This browser does not support script injection required to inspect page metrics.');
    }

    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => window.devicePixelRatio || 1
    });

    const firstResult = results[0]?.result;
    return typeof firstResult === 'number' && Number.isFinite(firstResult) ? firstResult : 1;
  }

  private computeCaptureScale(widthCssPx: number, heightCssPx: number, devicePixelRatio: number): number {
    const cappedDeviceScale = Math.max(1, devicePixelRatio);
    const dimensionScale = Math.min(MAX_CAPTURE_DIMENSION / widthCssPx, MAX_CAPTURE_DIMENSION / heightCssPx, cappedDeviceScale);
    const areaScale = Math.sqrt(MAX_CAPTURE_AREA / (widthCssPx * heightCssPx));
    const scale = Math.min(cappedDeviceScale, dimensionScale, areaScale);

    if (!Number.isFinite(scale) || scale <= 0) {
      throw new ExtensionError('Computed capture scale is invalid for the current page size.');
    }

    return Number(scale.toFixed(2));
  }
}
