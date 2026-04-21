import type { BrowserTab } from '../../domain/models/BrowserTab';
import type { CapturedPage } from '../../domain/models/CapturedPage';
import type { ExtensionSettings } from '../../domain/models/ExtensionSettings';
import type { FullPageCaptureGateway } from '../../domain/ports/FullPageCaptureGateway';
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

    try {
      await this.debuggerClient.sendCommand(debuggee, 'Page.enable');
      const layoutMetrics = await this.debuggerClient.sendCommand<LayoutMetricsResult>(debuggee, 'Page.getLayoutMetrics');
      const devicePixelRatio = await this.readDevicePixelRatio(tab.id);

      const widthCssPx = Math.max(1, Math.ceil(layoutMetrics.contentSize.width));
      const heightCssPx = Math.max(1, Math.ceil(layoutMetrics.contentSize.height));
      const scale = this.computeCaptureScale(widthCssPx, heightCssPx, devicePixelRatio);

      const result = await this.debuggerClient.sendCommand<CaptureScreenshotResult>(debuggee, 'Page.captureScreenshot', {
        format: 'png',
        fromSurface: true,
        captureBeyondViewport: true,
        optimizeForSpeed: true,
        clip: {
          x: 0,
          y: 0,
          width: widthCssPx,
          height: heightCssPx,
          scale
        }
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
      await this.debuggerClient.detach(debuggee).catch(() => undefined);
    }
  }

  private async readDevicePixelRatio(tabId: number): Promise<number> {
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
