import type { BridgeRuntime } from '../../domain/ports/BridgeRuntime';
import type { FullPageCaptureGateway } from '../../domain/ports/FullPageCaptureGateway';
import { getBrowserCapabilities, getBrowserIdentity, type BrowserCapabilities, type BrowserIdentity } from '../../shared/browserCapabilities';
import { ChromeDebuggerClient } from './ChromeDebuggerClient';
import { ChromeFullPageCaptureGateway } from './ChromeFullPageCaptureGateway';
import { ChromeOffscreenBridgeRuntime } from './ChromeOffscreenBridgeRuntime';
import { UnsupportedBridgeRuntime } from './UnsupportedBridgeRuntime';
import { UnsupportedFullPageCaptureGateway } from './UnsupportedFullPageCaptureGateway';

export interface BrowserPlatformAdapters {
  browserIdentity: BrowserIdentity;
  capabilities: BrowserCapabilities;
  bridgeRuntime: BridgeRuntime;
  fullPageCaptureGateway: FullPageCaptureGateway;
}

export function createBrowserPlatformAdapters(): BrowserPlatformAdapters {
  const browserIdentity = getBrowserIdentity();
  const capabilities = getBrowserCapabilities();

  const bridgeRuntime = capabilities.offscreenDocument && capabilities.runtimeMessaging
    ? new ChromeOffscreenBridgeRuntime()
    : new UnsupportedBridgeRuntime(
        `${browserIdentity.name} does not support the offscreen bridge APIs required for the desktop connection.`
      );

  const fullPageCaptureGateway = capabilities.debuggerApi && capabilities.scriptingApi
    ? new ChromeFullPageCaptureGateway(new ChromeDebuggerClient())
    : new UnsupportedFullPageCaptureGateway(
        `${browserIdentity.name} does not support the debugger-based full-page capture APIs. Popup, clipboard, and bridge features can still run, but screenshot capture is unavailable.`
      );

  return {
    browserIdentity,
    capabilities,
    bridgeRuntime,
    fullPageCaptureGateway,
  };
}