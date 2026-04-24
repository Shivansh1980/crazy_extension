import { CaptureCycleService } from '../application/services/CaptureCycleService';
import type { BrowserTab } from '../domain/models/BrowserTab';
import { BridgeLifecycleService } from '../application/services/BridgeLifecycleService';
import { BLOCKED_PROTOCOL_PREFIXES, SETTINGS_STORAGE_KEY } from '../shared/constants';
import { getUnsupportedCapabilitiesSummary } from '../shared/browserCapabilities';
import { ChromeActiveTabGateway } from '../infrastructure/browser/ChromeActiveTabGateway';
import { ChromeClipboardAccessGateway } from '../infrastructure/browser/ChromeClipboardAccessGateway';
import { ChromePagePopupGateway, type PagePopupStatus } from '../infrastructure/browser/ChromePagePopupGateway';
import { ChromeScreenShareGateway, type ScreenShareStatus } from '../infrastructure/browser/ChromeScreenShareGateway';
import { createBrowserPlatformAdapters } from '../infrastructure/browser/createBrowserPlatformAdapters';
import { ChromeRunStatusRepository } from '../infrastructure/storage/ChromeRunStatusRepository';
import { ChromeSettingsRepository } from '../infrastructure/storage/ChromeSettingsRepository';
import { debugError, debugLog } from '../shared/debug';

const browserPlatform = createBrowserPlatformAdapters();
const activeTabGateway = new ChromeActiveTabGateway();
const settingsRepository = new ChromeSettingsRepository();
const runStatusRepository = new ChromeRunStatusRepository();
const captureCycleService = new CaptureCycleService(
  settingsRepository,
  activeTabGateway,
  browserPlatform.fullPageCaptureGateway,
  runStatusRepository
);
const bridgeLifecycleService = new BridgeLifecycleService(settingsRepository, browserPlatform.bridgeRuntime);
const clipboardAccessGateway = new ChromeClipboardAccessGateway();
const pagePopupGateway = new ChromePagePopupGateway();
const screenShareGateway = new ChromeScreenShareGateway();
const recentPopupMessages: Array<{
  text: string;
  pageUrl: string | null;
  tabId: number | null;
  sentAt: string;
}> = [];
const SCREEN_SHARE_STOP_OVERLAY_ID = 'page-signal-screen-share-stop';
let latestPopupStatus: PagePopupStatus = {
  exists: false,
  state: 'closed',
  tabId: null,
  pageUrl: null,
  updatedAt: new Date().toISOString(),
  textLength: 0
};
let latestScreenShareStatus: ScreenShareStatus = screenShareGateway.getStatus();
let latestScreenShareOverlayTabId: number | null = null;

debugLog('background', 'Detected browser capabilities.', {
  browser: browserPlatform.browserIdentity,
  capabilities: browserPlatform.capabilities,
});

const unsupportedCapabilities = getUnsupportedCapabilitiesSummary();
if (unsupportedCapabilities.length > 0) {
  debugError('background', 'Some browser capabilities are unavailable. Related features will degrade gracefully.', unsupportedCapabilities);
}

async function runCaptureCycle() {
  debugLog('background', 'Running capture cycle.');
  return captureCycleService.execute();
}

async function ensureBridge(): Promise<void> {
  try {
    debugLog('background', 'Ensuring offscreen bridge is online.');
    await bridgeLifecycleService.ensureOnline();
    debugLog('background', 'running...');
  } catch (error) {
    debugError('background', 'Bridge lifecycle sync failed.', error);
  }
}

function toBrowserTab(tab: chrome.tabs.Tab | undefined): BrowserTab | null {
  if (!tab?.id || !tab.url || BLOCKED_PROTOCOL_PREFIXES.some((prefix) => tab.url?.startsWith(prefix))) {
    return null;
  }

  return {
    id: tab.id,
    title: tab.title ?? 'Untitled page',
    url: tab.url,
  };
}

async function enableClipboardAccessForTab(tab: BrowserTab, trigger: string): Promise<void> {
  try {
    const result = await clipboardAccessGateway.enable(tab);
    if (result.methodsFailed.length > 0) {
      debugError('background', 'Clipboard access enable completed with fallback failures.', {
        trigger,
        ...result,
      });
      return;
    }

    debugLog('background', 'Clipboard access enable completed.', {
      trigger,
      ...result,
    });
  } catch (error) {
    debugError('background', 'Clipboard access injection failed; extension will continue normally.', {
      trigger,
      tabId: tab.id,
      pageUrl: tab.url,
      error,
    });
  }
}

async function enableClipboardAccessOnActiveTab(trigger: string): Promise<void> {
  const tab = await activeTabGateway.getActiveCapturableTab();
  if (!tab) {
    debugLog('background', 'No active tab is available for clipboard access enable.', { trigger });
    return;
  }

  await enableClipboardAccessForTab(tab, trigger);
}

async function showPagePopup(text: string) {
  const tab = await activeTabGateway.getActiveCapturableTab();
  if (!tab) {
    throw new Error('No active capturable tab is available for the browser popup.');
  }

  const result = await pagePopupGateway.show(tab, text);
  latestPopupStatus = result;
  notifyPopupStatusChanged(result);
  return result;
}

async function startScreenShare() {
  const result = await screenShareGateway.start();
  latestScreenShareStatus = result;
  notifyScreenShareStatusChanged(result);
  return result;
}

async function requestScreenShareStop() {
  const response = await new Promise<{ ok?: boolean; message?: string }>((resolve) => {
    chrome.runtime.sendMessage({ type: 'screen-share-force-stop' }, (result) => {
      const runtimeError = chrome.runtime.lastError;
      if (runtimeError) {
        resolve({ ok: false, message: runtimeError.message });
        return;
      }

      resolve((result ?? { ok: true }) as { ok?: boolean; message?: string });
    });
  });

  if (response.ok === false) {
    throw new Error(response.message || 'Screen share stop request failed.');
  }

  return latestScreenShareStatus;
}

async function closePagePopup() {
  const tab = await activeTabGateway.getActiveCapturableTab();
  if (!tab) {
    latestPopupStatus = {
      exists: false,
      state: 'closed',
      tabId: null,
      pageUrl: null,
      updatedAt: new Date().toISOString(),
      textLength: 0
    };
    notifyPopupStatusChanged(latestPopupStatus);
    return latestPopupStatus;
  }

  const result = await pagePopupGateway.close(tab);
  latestPopupStatus = result;
  notifyPopupStatusChanged(result);
  return result;
}

async function togglePagePopup() {
  const status = await readPopupStatus();
  if (status.exists) {
    debugLog('background', 'Popup already exists on active tab; closing it from keyboard command.', status);
    return closePagePopup();
  }

  debugLog('background', 'Popup is not present on active tab; opening it from keyboard command.');
  return showPagePopup('');
}

async function readPopupStatus() {
  const tab = await activeTabGateway.getActiveCapturableTab();
  if (!tab) {
    latestPopupStatus = {
      exists: false,
      state: 'closed',
      tabId: null,
      pageUrl: null,
      updatedAt: new Date().toISOString(),
      textLength: 0
    };
    return latestPopupStatus;
  }

  latestPopupStatus = await pagePopupGateway.getStatus(tab);
  return latestPopupStatus;
}

function notifyPopupStatusChanged(status: PagePopupStatus): void {
  void chrome.runtime.sendMessage({ type: 'popup-status-changed', status }).catch(() => undefined);
}

function notifyScreenShareStatusChanged(status: ScreenShareStatus): void {
  void chrome.runtime.sendMessage({ type: 'screen-share-status-changed', status }).catch(() => undefined);
}

function notifyPopupMessage(payload: {
  text: string;
  pageUrl: string | null;
  tabId: number | null;
  sentAt: string;
}): void {
  void chrome.runtime.sendMessage({ type: 'popup-page-message', payload }).catch(() => undefined);
}

function recordPopupMessage(payload: {
  text: string;
  pageUrl: string | null;
  tabId: number | null;
  sentAt: string;
}): void {
  recentPopupMessages.unshift(payload);
  if (recentPopupMessages.length > 2) {
    recentPopupMessages.length = 2;
  }
}

async function syncScreenShareClientControls(status: ScreenShareStatus): Promise<void> {
  if (status.active) {
    const tab = await activeTabGateway.getActiveCapturableTab();
    if (!tab) {
      return;
    }

    latestScreenShareOverlayTabId = tab.id;
    await injectScreenShareStopOverlay(tab.id);
    return;
  }

  if (latestScreenShareOverlayTabId !== null) {
    await removeScreenShareStopOverlay(latestScreenShareOverlayTabId);
    latestScreenShareOverlayTabId = null;
  }
}

async function injectScreenShareStopOverlay(tabId: number): Promise<void> {
  if (!chrome.scripting?.executeScript) {
    return;
  }

  await chrome.scripting.executeScript({
    target: { tabId },
    func: (overlayId: string) => {
      const existing = document.getElementById(overlayId);
      if (existing) {
        return;
      }

      const button = document.createElement('button');
      button.id = overlayId;
      button.type = 'button';
      button.textContent = 'Stop Sharing';
      button.style.position = 'fixed';
      button.style.top = '14px';
      button.style.right = '14px';
      button.style.zIndex = '2147483647';
      button.style.border = '1px solid rgba(15, 23, 42, 0.18)';
      button.style.borderRadius = '999px';
      button.style.padding = '10px 16px';
      button.style.background = 'linear-gradient(135deg, #dc2626, #ef4444)';
      button.style.color = '#fff';
      button.style.font = '600 13px Segoe UI, system-ui, sans-serif';
      button.style.boxShadow = '0 18px 32px rgba(15, 23, 42, 0.28)';
      button.style.cursor = 'pointer';
      button.style.pointerEvents = 'auto';
      button.addEventListener('click', () => {
        void chrome.runtime.sendMessage({ type: 'screen-share-stop-request' }).catch(() => undefined);
      });
      document.documentElement.appendChild(button);
    },
    args: [SCREEN_SHARE_STOP_OVERLAY_ID],
  });
}

async function removeScreenShareStopOverlay(tabId: number): Promise<void> {
  if (!chrome.scripting?.executeScript) {
    return;
  }

  await chrome.scripting.executeScript({
    target: { tabId },
    func: (overlayId: string) => {
      document.getElementById(overlayId)?.remove();
    },
    args: [SCREEN_SHARE_STOP_OVERLAY_ID],
  }).catch(() => undefined);
}

chrome.runtime.onInstalled.addListener(() => {
  debugLog('background', 'Extension installed event received.');
  void ensureBridge();
  void enableClipboardAccessOnActiveTab('runtime-installed');
});

chrome.runtime.onStartup.addListener(() => {
  debugLog('background', 'Extension startup event received.');
  void ensureBridge();
  void enableClipboardAccessOnActiveTab('runtime-startup');
});

chrome.tabs?.onActivated?.addListener((activeInfo) => {
  void (async () => {
    try {
      const tab = toBrowserTab(await chrome.tabs.get(activeInfo.tabId));
      if (!tab) {
        return;
      }

      await enableClipboardAccessForTab(tab, 'tab-activated');
    } catch (error) {
      debugError('background', 'Clipboard access enable failed on tab activation; continuing normally.', error);
    }
  })();
});

chrome.tabs?.onUpdated?.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete' || !tab.active) {
    return;
  }

  const browserTab = toBrowserTab({ ...tab, id: tab.id ?? tabId });
  if (!browserTab) {
    return;
  }

  void enableClipboardAccessForTab(browserTab, 'tab-updated');
});

chrome.windows?.onRemoved?.addListener((windowId) => {
  const status = screenShareGateway.handleViewerWindowRemoved(windowId);
  if (!status) {
    return;
  }

  latestScreenShareStatus = status;
  notifyScreenShareStatusChanged(status);
});

chrome.commands?.onCommand.addListener((command) => {
  void (async () => {
    try {
      await ensureBridge();

      if (command === 'toggle-popup') {
        debugLog('background', 'Keyboard command received for popup toggle.');
        await togglePagePopup();
      }
    } catch (error) {
      debugError('background', 'Keyboard popup toggle failed.', error);
    }
  })();
});

chrome.storage?.onChanged?.addListener((changes, areaName) => {
  if (areaName === 'sync' && changes[SETTINGS_STORAGE_KEY]) {
    debugLog('background', 'Settings changed, restarting bridge.', changes[SETTINGS_STORAGE_KEY]);
    void ensureBridge();
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  debugLog('background', 'Received runtime message.', message?.type ?? 'unknown');

  if (message?.type === 'storage-get') {
    void (async () => {
      try {
        const storageArea = resolveStorageArea(message.area);
        const storageResult = await storageArea.get(message.key);
        sendResponse({ ok: true, value: storageResult[message.key] });
      } catch (error) {
        const messageText = error instanceof Error ? error.message : 'Storage read failed.';
        debugError('background', 'Storage read failed.', { area: message.area, key: message.key, error: messageText });
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
        debugError('background', 'Storage write failed.', { area: message.area, key: message.key, error: messageText });
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
        debugError('background', 'Manual capture failed.', messageText);
        sendResponse({ ok: false, message: messageText });
      });
    return true;
  }

  if (message?.type === 'bridge-capture-request') {
    void runCaptureCycle()
      .then((capturedPage) => sendResponse({ ok: true, capturedPage }))
      .catch((error) => {
        const messageText = error instanceof Error ? error.message : 'Capture failed.';
        debugError('background', 'Bridge capture request failed.', messageText);
        sendResponse({ ok: false, message: messageText });
      });
    return true;
  }

  if (message?.type === 'ensure-bridge') {
    void ensureBridge()
      .then(() => sendResponse({ ok: true }))
      .catch((error) => {
        const messageText = error instanceof Error ? error.message : 'Bridge startup failed.';
        debugError('background', 'Bridge ensure request failed.', messageText);
        sendResponse({ ok: false, message: messageText });
      });
    return true;
  }

  if (message?.type === 'bridge-popup-show') {
    void showPagePopup(String(message.text ?? ''))
      .then((status) => sendResponse({ ok: true, status, action: status.action }))
      .catch((error) => {
        const messageText = error instanceof Error ? error.message : 'Popup creation failed.';
        debugError('background', 'Bridge popup request failed.', messageText);
        sendResponse({ ok: false, message: messageText });
      });
    return true;
  }

  if (message?.type === 'bridge-screen-share-start') {
    void startScreenShare()
      .then((status) => sendResponse({ ok: true, status }))
      .catch((error) => {
        const messageText = error instanceof Error ? error.message : 'Screen share start failed.';
        debugError('background', 'Bridge screen share request failed.', messageText);
        sendResponse({ ok: false, message: messageText, status: latestScreenShareStatus });
      });
    return true;
  }

  if (message?.type === 'bridge-screen-share-stop') {
    void requestScreenShareStop()
      .then((status) => sendResponse({ ok: true, status }))
      .catch((error) => {
        const messageText = error instanceof Error ? error.message : 'Screen share stop failed.';
        debugError('background', 'Bridge screen share stop request failed.', messageText);
        sendResponse({ ok: false, message: messageText, status: latestScreenShareStatus });
      });
    return true;
  }

  if (message?.type === 'popup-status-get') {
    void readPopupStatus()
      .then((status) => sendResponse({ ok: true, status }))
      .catch((error) => {
        const messageText = error instanceof Error ? error.message : 'Popup status lookup failed.';
        debugError('background', 'Popup status lookup failed.', messageText);
        sendResponse({ ok: false, message: messageText, status: latestPopupStatus });
      });
    return true;
  }

  if (message?.type === 'popup-message-history-get') {
    sendResponse({ ok: true, messages: [...recentPopupMessages] });
    return true;
  }

  if (message?.type === 'popup-status-update') {
    latestPopupStatus = {
      exists: Boolean(message.status?.exists),
      state: message.status?.state === 'open' || message.status?.state === 'minimized' || message.status?.state === 'closed'
        ? message.status.state
        : 'unknown',
      tabId: typeof message.status?.tabId === 'number' ? message.status.tabId : null,
      pageUrl: typeof message.status?.pageUrl === 'string' ? message.status.pageUrl : null,
      updatedAt: typeof message.status?.updatedAt === 'string' ? message.status.updatedAt : new Date().toISOString(),
      textLength: typeof message.status?.textLength === 'number' ? message.status.textLength : 0
    };
    notifyPopupStatusChanged(latestPopupStatus);
    sendResponse({ ok: true });
    return true;
  }

  if (message?.type === 'popup-message-send') {
    const text = typeof message.payload?.text === 'string' ? message.payload.text : '';
    const payload = {
      text,
      pageUrl: sender.tab?.url ?? (typeof message.payload?.pageUrl === 'string' ? message.payload.pageUrl : null),
      tabId: sender.tab?.id ?? (typeof message.payload?.tabId === 'number' ? message.payload.tabId : null),
      sentAt: new Date().toISOString()
    };

    debugLog('background', 'Received popup text from page.', {
      tabId: payload.tabId,
      pageUrl: payload.pageUrl,
      characters: text.length
    });
    recordPopupMessage(payload);
    notifyPopupMessage(payload);
    sendResponse({ ok: true });
    return true;
  }

  if (message?.type === 'screen-share-status-get') {
    sendResponse({ ok: true, status: latestScreenShareStatus });
    return true;
  }

  if (message?.type === 'screen-share-viewer-ready') {
    sendResponse({ ok: true, status: latestScreenShareStatus });
    return true;
  }

  if (message?.type === 'screen-share-stream-endpoint-get') {
    void (async () => {
      try {
        const runStatus = await runStatusRepository.get();
        sendResponse({ ok: true, targetUrl: runStatus.targetUrl });
      } catch (error) {
        const messageText = error instanceof Error ? error.message : 'Screen share stream endpoint lookup failed.';
        debugError('background', 'Screen share stream endpoint lookup failed.', messageText);
        sendResponse({ ok: false, message: messageText });
      }
    })();
    return true;
  }

  if (message?.type === 'screen-share-viewer-status') {
    latestScreenShareStatus = screenShareGateway.updateStatus({
      state:
        message.status?.state === 'idle' ||
        message.status?.state === 'launching' ||
        message.status?.state === 'active' ||
        message.status?.state === 'ended' ||
        message.status?.state === 'error'
          ? message.status.state
          : 'error',
      active: Boolean(message.status?.active),
      viewerWindowId: typeof message.status?.viewerWindowId === 'number' ? message.status.viewerWindowId : latestScreenShareStatus.viewerWindowId,
      sourceLabel: typeof message.status?.sourceLabel === 'string' ? message.status.sourceLabel : null,
      updatedAt: typeof message.status?.updatedAt === 'string' ? message.status.updatedAt : new Date().toISOString(),
      message: typeof message.status?.message === 'string' ? message.status.message : 'Screen share status updated.'
    });
    void syncScreenShareClientControls(latestScreenShareStatus);
    notifyScreenShareStatusChanged(latestScreenShareStatus);
    sendResponse({ ok: true, status: latestScreenShareStatus });
    return true;
  }

  if (message?.type === 'screen-share-stop-request') {
    void requestScreenShareStop().catch((error) => {
      debugError('background', 'Screen share stop request from page failed.', error);
    });
    sendResponse({ ok: true, status: latestScreenShareStatus });
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
