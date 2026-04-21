import { CaptureCycleService } from '../application/services/CaptureCycleService';
import { BridgeLifecycleService } from '../application/services/BridgeLifecycleService';
import { SETTINGS_STORAGE_KEY } from '../shared/constants';
import { ChromeActiveTabGateway } from '../infrastructure/browser/ChromeActiveTabGateway';
import { ChromeDebuggerClient } from '../infrastructure/browser/ChromeDebuggerClient';
import { ChromeFullPageCaptureGateway } from '../infrastructure/browser/ChromeFullPageCaptureGateway';
import { ChromeOffscreenBridgeRuntime } from '../infrastructure/browser/ChromeOffscreenBridgeRuntime';
import { ChromeRunStatusRepository } from '../infrastructure/storage/ChromeRunStatusRepository';
import { ChromeSettingsRepository } from '../infrastructure/storage/ChromeSettingsRepository';

const settingsRepository = new ChromeSettingsRepository();
const runStatusRepository = new ChromeRunStatusRepository();
const captureCycleService = new CaptureCycleService(
  settingsRepository,
  new ChromeActiveTabGateway(),
  new ChromeFullPageCaptureGateway(new ChromeDebuggerClient()),
  runStatusRepository
);
const bridgeLifecycleService = new BridgeLifecycleService(settingsRepository, new ChromeOffscreenBridgeRuntime());

async function runCaptureCycle() {
  return captureCycleService.execute();
}

async function ensureBridge(): Promise<void> {
  try {
    await bridgeLifecycleService.ensureOnline();
  } catch (error) {
    console.error('Bridge lifecycle sync failed.', error);
  }
}

chrome.runtime.onInstalled.addListener(() => {
  void ensureBridge();
});

chrome.runtime.onStartup.addListener(() => {
  void ensureBridge();
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'sync' && changes[SETTINGS_STORAGE_KEY]) {
    void ensureBridge();
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'capture-now') {
    void runCaptureCycle()
      .then((capturedPage) => sendResponse({ ok: true, capturedPage }))
      .catch((error) => {
        const messageText = error instanceof Error ? error.message : 'Capture failed.';
        sendResponse({ ok: false, message: messageText });
      });
    return true;
  }

  if (message?.type === 'bridge-capture-request') {
    void runCaptureCycle()
      .then((capturedPage) => sendResponse({ ok: true, capturedPage }))
      .catch((error) => {
        const messageText = error instanceof Error ? error.message : 'Capture failed.';
        sendResponse({ ok: false, message: messageText });
      });
    return true;
  }

  if (message?.type === 'ensure-bridge') {
    void ensureBridge()
      .then(() => sendResponse({ ok: true }))
      .catch((error) => {
        const messageText = error instanceof Error ? error.message : 'Bridge startup failed.';
        sendResponse({ ok: false, message: messageText });
      });
    return true;
  }

  return false;
});

void ensureBridge();
