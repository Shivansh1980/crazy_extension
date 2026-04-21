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

chrome.storage?.onChanged?.addListener((changes, areaName) => {
  if (areaName === 'sync' && changes[SETTINGS_STORAGE_KEY]) {
    void ensureBridge();
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'storage-get') {
    void (async () => {
      try {
        const storageArea = resolveStorageArea(message.area);
        const storageResult = await storageArea.get(message.key);
        sendResponse({ ok: true, value: storageResult[message.key] });
      } catch (error) {
        const messageText = error instanceof Error ? error.message : 'Storage read failed.';
        sendResponse({ ok: false, message: messageText });
      }
    })();
    return true;
  }

  if (message?.type === 'storage-set') {
    void (async () => {
      try {
        const storageArea = resolveStorageArea(message.area);
        await storageArea.set({ [message.key]: message.value });
        sendResponse({ ok: true });
      } catch (error) {
        const messageText = error instanceof Error ? error.message : 'Storage write failed.';
        sendResponse({ ok: false, message: messageText });
      }
    })();
    return true;
  }

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

function resolveStorageArea(area: unknown): chrome.storage.StorageArea {
  if (area === 'sync' && chrome.storage?.sync) {
    return chrome.storage.sync;
  }

  if (chrome.storage?.local) {
    return chrome.storage.local;
  }

  throw new Error('No supported chrome.storage area is available in the background context.');
}

void ensureBridge();
