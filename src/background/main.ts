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

async function resolveScreenShareTabId(): Promise<number> {
  let targetTabId = latestScreenShareOverlayTabId;

  if (targetTabId !== null) {
    try {
      // Verify the recorded overlay tab still exists.
      await chrome.tabs.get(targetTabId);
    } catch {
      targetTabId = null;
      latestScreenShareOverlayTabId = null;
    }
  }

  if (targetTabId === null) {
    // Pick the active tab in the most recently focused normal browser window. This skips the
    // screen-share viewer popup (which is window type "popup") so input goes back to the
    // browsing tab the operator was using before they started sharing.
    try {
      const candidateTabs = await chrome.tabs.query({ active: true, windowType: 'normal' });
      const usable = candidateTabs.find((tab) => {
        if (!tab.id || !tab.url) {
          return false;
        }
        return !BLOCKED_PROTOCOL_PREFIXES.some((prefix) => tab.url!.startsWith(prefix));
      });
      if (usable?.id !== undefined) {
        targetTabId = usable.id;
      }
    } catch (error) {
      debugError('background', 'Failed to enumerate browser tabs for remote input fallback.', error);
    }
  }

  if (targetTabId === null) {
    const activeTab = await activeTabGateway.getActiveCapturableTab();
    targetTabId = activeTab?.id ?? null;
  }

  if (targetTabId === null) {
    throw new Error('No shared browser tab is available for remote input delivery. Switch to a regular browser tab and retry, or run the native client agent for OS-level control.');
  }

  return targetTabId;
}

async function focusScreenShareTab(targetTabId: number): Promise<void> {
  // Intentionally a no-op: focusing the captured window steals focus from the screen-share
  // viewer popup and the operator's GUI. Chrome `scripting.executeScript` works on inactive
  // tabs, so we leave focus alone and rely on direct event injection.
  void targetTabId;
}

type ScreenShareInputAction = 'pointer-down' | 'pointer-up' | 'pointer-move' | 'click' | 'double-click' | 'wheel';
type ScreenShareKeyAction = 'down' | 'up' | 'type';
interface ScreenShareModifiers {
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
  meta?: boolean;
}

async function dispatchScreenShareInput(payload: {
  action: ScreenShareInputAction;
  normalizedX: number;
  normalizedY: number;
  button?: number;
  buttons?: number;
  deltaX?: number;
  deltaY?: number;
  modifiers?: ScreenShareModifiers;
}) {
  if (!latestScreenShareStatus.active) {
    throw new Error('Screen share is not active. Start sharing before sending remote input.');
  }

  if (!chrome.scripting?.executeScript) {
    throw new Error('This browser cannot inject remote input handlers into the shared page.');
  }

  const targetTabId = await resolveScreenShareTabId();
  await focusScreenShareTab(targetTabId);

  const [result] = await chrome.scripting.executeScript({
    target: { tabId: targetTabId },
    func: (
      action: string,
      xRatio: number,
      yRatio: number,
      button: number,
      buttons: number,
      deltaX: number,
      deltaY: number,
      modifiers: { ctrl?: boolean; shift?: boolean; alt?: boolean; meta?: boolean },
      overlayId: string,
    ) => {
      const viewportWidth = Math.max(1, window.innerWidth || document.documentElement.clientWidth || 1);
      const viewportHeight = Math.max(1, window.innerHeight || document.documentElement.clientHeight || 1);
      const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
      const clientX = clamp(Math.round(xRatio * viewportWidth), 0, Math.max(0, viewportWidth - 1));
      const clientY = clamp(Math.round(yRatio * viewportHeight), 0, Math.max(0, viewportHeight - 1));
      const overlay = document.getElementById(overlayId) as HTMLElement | null;

      let target = document.elementFromPoint(clientX, clientY) as HTMLElement | null;
      if (target && overlay && target === overlay) {
        const previousPointerEvents = overlay.style.pointerEvents;
        overlay.style.pointerEvents = 'none';
        target = document.elementFromPoint(clientX, clientY) as HTMLElement | null;
        overlay.style.pointerEvents = previousPointerEvents || 'auto';
      }

      if (!target) {
        return {
          ok: false,
          message: 'No page element was found at the selected point.',
          targetDescription: 'none',
          viewportWidth,
          viewportHeight,
        };
      }

      const mods = modifiers || {};
      const baseInit: MouseEventInit = {
        bubbles: true,
        cancelable: true,
        composed: true,
        button,
        buttons,
        clientX,
        clientY,
        view: window,
        ctrlKey: !!mods.ctrl,
        shiftKey: !!mods.shift,
        altKey: !!mods.alt,
        metaKey: !!mods.meta,
      };
      const pointerInit: PointerEventInit = {
        ...baseInit,
        pointerId: 1,
        pointerType: 'mouse',
        isPrimary: true,
      };

      const dispatchPointerAndMouse = (pointerType: string, mouseType: string) => {
        if (typeof PointerEvent !== 'undefined') {
          target!.dispatchEvent(new PointerEvent(pointerType, pointerInit));
        }
        target!.dispatchEvent(new MouseEvent(mouseType, baseInit));
      };

      switch (action) {
        case 'pointer-move': {
          dispatchPointerAndMouse('pointermove', 'mousemove');
          break;
        }
        case 'pointer-down': {
          target.dispatchEvent(new MouseEvent('mouseover', baseInit));
          dispatchPointerAndMouse('pointerdown', 'mousedown');
          break;
        }
        case 'pointer-up': {
          dispatchPointerAndMouse('pointerup', 'mouseup');
          break;
        }
        case 'click': {
          target.dispatchEvent(new MouseEvent('mouseover', baseInit));
          target.dispatchEvent(new MouseEvent('mousemove', baseInit));
          if (typeof PointerEvent !== 'undefined') {
            target.dispatchEvent(new PointerEvent('pointerdown', pointerInit));
            target.dispatchEvent(new PointerEvent('pointerup', pointerInit));
          }
          target.dispatchEvent(new MouseEvent('mousedown', baseInit));
          target.dispatchEvent(new MouseEvent('mouseup', baseInit));
          target.dispatchEvent(new MouseEvent('click', baseInit));
          if (typeof target.focus === 'function') {
            try {
              target.focus({ preventScroll: true });
            } catch {
              target.focus();
            }
          }
          if (typeof target.click === 'function') {
            target.click();
          }
          break;
        }
        case 'double-click': {
          target.dispatchEvent(new MouseEvent('mousedown', baseInit));
          target.dispatchEvent(new MouseEvent('mouseup', baseInit));
          target.dispatchEvent(new MouseEvent('click', baseInit));
          target.dispatchEvent(new MouseEvent('mousedown', baseInit));
          target.dispatchEvent(new MouseEvent('mouseup', baseInit));
          target.dispatchEvent(new MouseEvent('click', baseInit));
          target.dispatchEvent(new MouseEvent('dblclick', baseInit));
          break;
        }
        case 'wheel': {
          const wheelInit: WheelEventInit = {
            ...baseInit,
            deltaX,
            deltaY,
            deltaMode: 0,
          };
          const wheelEvent = new WheelEvent('wheel', wheelInit);
          const cancelled = !target.dispatchEvent(wheelEvent);
          if (!cancelled) {
            try {
              window.scrollBy({ left: deltaX, top: deltaY, behavior: 'auto' });
            } catch {
              window.scrollBy(deltaX, deltaY);
            }
          }
          break;
        }
        default: {
          return {
            ok: false,
            message: `Unsupported remote input action: ${action}`,
            targetDescription: 'none',
            viewportWidth,
            viewportHeight,
          };
        }
      }

      const targetDescription = [
        target.tagName.toLowerCase(),
        target.id ? `#${target.id}` : '',
        target.className ? `.${String(target.className).trim().replace(/\s+/g, '.')}` : '',
      ]
        .join('')
        .replace(/\.+$/, '') || 'page element';

      return {
        ok: true,
        message: `Remote ${action} delivered to ${targetDescription} at ${clientX}, ${clientY}.`,
        targetDescription,
        viewportWidth,
        viewportHeight,
      };
    },
    args: [
      payload.action,
      payload.normalizedX,
      payload.normalizedY,
      payload.button ?? 0,
      payload.buttons ?? 0,
      payload.deltaX ?? 0,
      payload.deltaY ?? 0,
      payload.modifiers ?? {},
      SCREEN_SHARE_STOP_OVERLAY_ID,
    ],
  });

  if (!result?.result?.ok) {
    throw new Error(result?.result?.message || 'Remote input injection failed on the shared page.');
  }

  return result.result;
}

async function dispatchScreenShareKey(payload: {
  action: ScreenShareKeyAction;
  key?: string;
  code?: string;
  text?: string;
  modifiers?: ScreenShareModifiers;
}) {
  if (!latestScreenShareStatus.active) {
    throw new Error('Screen share is not active. Start sharing before sending remote key events.');
  }

  if (!chrome.scripting?.executeScript) {
    throw new Error('This browser cannot inject remote key handlers into the shared page.');
  }

  const targetTabId = await resolveScreenShareTabId();
  await focusScreenShareTab(targetTabId);

  const [result] = await chrome.scripting.executeScript({
    target: { tabId: targetTabId },
    func: (
      action: string,
      key: string,
      code: string,
      text: string,
      modifiers: { ctrl?: boolean; shift?: boolean; alt?: boolean; meta?: boolean },
    ) => {
      const describeTarget = (target: Element) => {
        const el = target as HTMLElement;
        return [
          el.tagName.toLowerCase(),
          el.id ? `#${el.id}` : '',
          el.className ? `.${String(el.className).trim().replace(/\s+/g, '.')}` : '',
        ]
          .join('')
          .replace(/\.+$/, '') || 'focused element';
      };

      const getActiveElement = (): HTMLElement | null => {
        let active = document.activeElement as HTMLElement | null;
        while (active && (active as HTMLElement & { shadowRoot?: ShadowRoot | null }).shadowRoot) {
          const nested = ((active as HTMLElement & { shadowRoot?: ShadowRoot | null }).shadowRoot?.activeElement ?? null) as HTMLElement | null;
          if (!nested) {
            break;
          }
          active = nested;
        }
        return active ?? (document.body as HTMLElement | null);
      };

      const target = getActiveElement();
      if (!target) {
        return { ok: false, message: 'No focused element is available for remote key input.', targetDescription: 'none' };
      }

      const mods = modifiers || {};
      const init: KeyboardEventInit = {
        bubbles: true,
        cancelable: true,
        composed: true,
        key,
        code: code || key,
        ctrlKey: !!mods.ctrl,
        shiftKey: !!mods.shift,
        altKey: !!mods.alt,
        metaKey: !!mods.meta,
      };

      const isTextInput = (element: HTMLElement): element is HTMLInputElement | HTMLTextAreaElement => {
        if (element instanceof HTMLTextAreaElement) {
          return true;
        }
        if (!(element instanceof HTMLInputElement)) {
          return false;
        }
        const allowedTypes = new Set(['', 'email', 'number', 'password', 'search', 'tel', 'text', 'url']);
        return allowedTypes.has(element.type);
      };

      const insertTextIntoTarget = (insertText: string): boolean => {
        if (insertText === '' ) {
          return true;
        }
        if (isTextInput(target)) {
          if (target.disabled || target.readOnly) {
            return false;
          }
          const start = target.selectionStart ?? target.value.length;
          const end = target.selectionEnd ?? start;
          const next = `${target.value.slice(0, start)}${insertText}${target.value.slice(end)}`;
          target.value = next;
          const caret = start + insertText.length;
          target.setSelectionRange(caret, caret);
          target.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, data: insertText, inputType: 'insertText' }));
          target.dispatchEvent(new InputEvent('input', { bubbles: true, data: insertText, inputType: 'insertText' }));
          target.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        }
        if (target.isContentEditable) {
          const selection = window.getSelection();
          if (!selection) {
            return false;
          }
          let range: Range;
          if (selection.rangeCount > 0) {
            range = selection.getRangeAt(0);
          } else {
            range = document.createRange();
            range.selectNodeContents(target);
            range.collapse(false);
          }
          range.deleteContents();
          const node = document.createTextNode(insertText);
          range.insertNode(node);
          range.setStartAfter(node);
          range.collapse(true);
          selection.removeAllRanges();
          selection.addRange(range);
          target.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, data: insertText, inputType: 'insertText' }));
          target.dispatchEvent(new InputEvent('input', { bubbles: true, data: insertText, inputType: 'insertText' }));
          return true;
        }
        return false;
      };

      const handleBackspace = (): boolean => {
        if (isTextInput(target)) {
          if (target.disabled || target.readOnly) {
            return false;
          }
          const start = target.selectionStart ?? 0;
          const end = target.selectionEnd ?? start;
          if (start === end) {
            if (start === 0) {
              return true;
            }
            target.value = `${target.value.slice(0, start - 1)}${target.value.slice(start)}`;
            target.setSelectionRange(start - 1, start - 1);
          } else {
            target.value = `${target.value.slice(0, start)}${target.value.slice(end)}`;
            target.setSelectionRange(start, start);
          }
          target.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
          return true;
        }
        if (target.isContentEditable) {
          try {
            document.execCommand('delete', false);
            return true;
          } catch {
            return false;
          }
        }
        return false;
      };

      try {
        target.focus({ preventScroll: true });
      } catch {
        try { target.focus(); } catch { /* ignore */ }
      }

      switch (action) {
        case 'down': {
          target.dispatchEvent(new KeyboardEvent('keydown', init));
          if (key && key.length === 1 && !mods.ctrl && !mods.meta && !mods.alt) {
            insertTextIntoTarget(key);
          } else if (key === 'Enter' && !mods.ctrl && !mods.meta && !mods.alt) {
            insertTextIntoTarget('\n');
          } else if (key === 'Tab' && !mods.ctrl && !mods.meta && !mods.alt) {
            insertTextIntoTarget('\t');
          } else if (key === 'Backspace') {
            handleBackspace();
          }
          break;
        }
        case 'up': {
          target.dispatchEvent(new KeyboardEvent('keyup', init));
          break;
        }
        case 'type': {
          if (text) {
            for (const ch of text) {
              const charInit: KeyboardEventInit = { ...init, key: ch, code: '' };
              target.dispatchEvent(new KeyboardEvent('keydown', charInit));
              insertTextIntoTarget(ch);
              target.dispatchEvent(new KeyboardEvent('keyup', charInit));
            }
          }
          break;
        }
        default: {
          return { ok: false, message: `Unsupported remote key action: ${action}`, targetDescription: describeTarget(target) };
        }
      }

      return { ok: true, message: `Remote key ${action} delivered.`, targetDescription: describeTarget(target) };
    },
    args: [
      payload.action,
      payload.key ?? '',
      payload.code ?? '',
      payload.text ?? '',
      payload.modifiers ?? {},
    ],
  });

  if (!result?.result?.ok) {
    throw new Error(result?.result?.message || 'Remote key injection failed on the shared page.');
  }

  return result.result;
}

async function dispatchScreenShareClick(normalizedX: number, normalizedY: number) {
  if (!latestScreenShareStatus.active) {
    throw new Error('Screen share is not active. Start sharing before sending remote clicks.');
  }

  if (!chrome.scripting?.executeScript) {
    throw new Error('This browser cannot inject remote click handlers into the shared page.');
  }

  const targetTabId = await resolveScreenShareTabId();
  await focusScreenShareTab(targetTabId);

  const [result] = await chrome.scripting.executeScript({
    target: { tabId: targetTabId },
    func: (xRatio: number, yRatio: number, overlayId: string) => {
      const viewportWidth = Math.max(1, window.innerWidth || document.documentElement.clientWidth || 1);
      const viewportHeight = Math.max(1, window.innerHeight || document.documentElement.clientHeight || 1);
      const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
      const clientX = clamp(Math.round(xRatio * viewportWidth), 0, Math.max(0, viewportWidth - 1));
      const clientY = clamp(Math.round(yRatio * viewportHeight), 0, Math.max(0, viewportHeight - 1));
      const overlay = document.getElementById(overlayId) as HTMLElement | null;
      let target = document.elementFromPoint(clientX, clientY) as HTMLElement | null;

      if (target && overlay && target === overlay) {
        const previousPointerEvents = overlay.style.pointerEvents;
        overlay.style.pointerEvents = 'none';
        target = document.elementFromPoint(clientX, clientY) as HTMLElement | null;
        overlay.style.pointerEvents = previousPointerEvents || 'auto';
      }

      if (!target) {
        return {
          ok: false,
          message: 'No page element was found at the selected point.',
          targetDescription: 'none',
          viewportWidth,
          viewportHeight,
        };
      }

      const eventInit: MouseEventInit = {
        bubbles: true,
        cancelable: true,
        composed: true,
        button: 0,
        buttons: 1,
        clientX,
        clientY,
        view: window,
      };

      if (typeof PointerEvent !== 'undefined') {
        const pointerInit: PointerEventInit = {
          ...eventInit,
          pointerId: 1,
          pointerType: 'mouse',
          isPrimary: true,
        };
        target.dispatchEvent(new PointerEvent('pointerdown', pointerInit));
        target.dispatchEvent(new PointerEvent('pointerup', pointerInit));
      }

      target.dispatchEvent(new MouseEvent('mouseover', eventInit));
      target.dispatchEvent(new MouseEvent('mousemove', eventInit));
      target.dispatchEvent(new MouseEvent('mousedown', eventInit));
      target.dispatchEvent(new MouseEvent('mouseup', eventInit));
      target.dispatchEvent(new MouseEvent('click', eventInit));

      if (typeof target.focus === 'function') {
        try {
          target.focus({ preventScroll: true });
        } catch {
          target.focus();
        }
      }

      if (typeof target.click === 'function') {
        target.click();
      }

      const targetDescription = [target.tagName.toLowerCase(), target.id ? `#${target.id}` : '', target.className ? `.${String(target.className).trim().replace(/\s+/g, '.')}` : '']
        .join('')
        .replace(/\.+$/, '');

      return {
        ok: true,
        message: `Remote click delivered to ${targetDescription || 'the shared page'} at ${clientX}, ${clientY}.`,
        targetDescription: targetDescription || 'page element',
        viewportWidth,
        viewportHeight,
      };
    },
    args: [normalizedX, normalizedY, SCREEN_SHARE_STOP_OVERLAY_ID],
  });

  if (!result?.result?.ok) {
    throw new Error(result?.result?.message || 'Remote click injection failed on the shared page.');
  }

  return result.result;
}

async function dispatchScreenSharePaste(text: string) {
  if (!latestScreenShareStatus.active) {
    throw new Error('Screen share is not active. Start sharing before sending remote paste.');
  }

  if (!chrome.scripting?.executeScript) {
    throw new Error('This browser cannot inject remote paste handlers into the shared page.');
  }

  const targetTabId = await resolveScreenShareTabId();
  await focusScreenShareTab(targetTabId);

  const [result] = await chrome.scripting.executeScript({
    target: { tabId: targetTabId },
    func: (clipboardText: string) => {
      const describeTarget = (target: HTMLElement) => {
        return [
          target.tagName.toLowerCase(),
          target.id ? `#${target.id}` : '',
          target.className ? `.${String(target.className).trim().replace(/\s+/g, '.')}` : '',
        ]
          .join('')
          .replace(/\.+$/, '') || 'focused element';
      };

      const getActiveElement = (): HTMLElement | null => {
        let active = document.activeElement as HTMLElement | null;
        while (active && (active as HTMLElement & { shadowRoot?: ShadowRoot | null }).shadowRoot) {
          const nestedActive = ((active as HTMLElement & { shadowRoot?: ShadowRoot | null }).shadowRoot?.activeElement ?? null) as HTMLElement | null;
          if (!nestedActive) {
            break;
          }
          active = nestedActive;
        }
        return active;
      };

      const isTextInput = (element: HTMLElement): element is HTMLInputElement | HTMLTextAreaElement => {
        if (element instanceof HTMLTextAreaElement) {
          return true;
        }

        if (!(element instanceof HTMLInputElement)) {
          return false;
        }

        const allowedTypes = new Set(['', 'email', 'number', 'password', 'search', 'tel', 'text', 'url']);
        return allowedTypes.has(element.type);
      };

      const activeElement = getActiveElement();
      if (!activeElement) {
        return { ok: false, message: 'No focused element is available on the shared page.', targetDescription: 'none', characterCount: 0 };
      }

      if (activeElement instanceof HTMLElement) {
        try {
          activeElement.focus({ preventScroll: true });
        } catch {
          activeElement.focus();
        }
      }

      const targetDescription = describeTarget(activeElement);

      if (isTextInput(activeElement)) {
        if (activeElement.disabled || activeElement.readOnly) {
          return { ok: false, message: 'The focused field cannot be edited.', targetDescription, characterCount: 0 };
        }

        const selectionStart = activeElement.selectionStart ?? activeElement.value.length;
        const selectionEnd = activeElement.selectionEnd ?? selectionStart;
        const nextValue = `${activeElement.value.slice(0, selectionStart)}${clipboardText}${activeElement.value.slice(selectionEnd)}`;
        activeElement.value = nextValue;
        const nextCaret = selectionStart + clipboardText.length;
        activeElement.setSelectionRange(nextCaret, nextCaret);
        activeElement.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, data: clipboardText, inputType: 'insertFromPaste' }));
        activeElement.dispatchEvent(new InputEvent('input', { bubbles: true, data: clipboardText, inputType: 'insertFromPaste' }));
        activeElement.dispatchEvent(new Event('change', { bubbles: true }));
        return {
          ok: true,
          message: `Pasted ${clipboardText.length} character(s) into ${targetDescription}.`,
          targetDescription,
          characterCount: clipboardText.length,
        };
      }

      if (activeElement.isContentEditable) {
        const selection = window.getSelection();
        if (!selection) {
          return { ok: false, message: 'The focused editable region does not expose a selection.', targetDescription, characterCount: 0 };
        }

        let range: Range;
        if (selection.rangeCount > 0) {
          range = selection.getRangeAt(0);
        } else {
          range = document.createRange();
          range.selectNodeContents(activeElement);
          range.collapse(false);
        }

        range.deleteContents();
        const textNode = document.createTextNode(clipboardText);
        range.insertNode(textNode);
        range.setStartAfter(textNode);
        range.collapse(true);
        selection.removeAllRanges();
        selection.addRange(range);
        activeElement.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, data: clipboardText, inputType: 'insertFromPaste' }));
        activeElement.dispatchEvent(new InputEvent('input', { bubbles: true, data: clipboardText, inputType: 'insertFromPaste' }));
        return {
          ok: true,
          message: `Pasted ${clipboardText.length} character(s) into ${targetDescription}.`,
          targetDescription,
          characterCount: clipboardText.length,
        };
      }

      return {
        ok: false,
        message: 'The focused element is not a text input, textarea, or editable region.',
        targetDescription,
        characterCount: 0,
      };
    },
    args: [text],
  });

  if (!result?.result?.ok) {
    throw new Error(result?.result?.message || 'Remote paste injection failed on the shared page.');
  }

  return result.result;
}

function sanitizeDownloadFileName(fileName: string) {
  const trimmed = fileName.trim();
  const sanitized = trimmed.replace(/[\\/:*?"<>|]+/g, '_').replace(/^\.+/, '');
  return sanitized || 'download.bin';
}

async function startManagedBrowserDownload(objectUrl: string, fileName: string) {
  const safeFileName = sanitizeDownloadFileName(fileName);
  const downloadId = await chrome.downloads.download({
    url: objectUrl,
    filename: safeFileName,
    conflictAction: 'uniquify',
    saveAs: false,
  });

  if (typeof downloadId !== 'number') {
    throw new Error('Browser download could not be started.');
  }

  return {
    savedPath: safeFileName,
    message: `${safeFileName} download started in the browser.`,
    downloadId,
  };
}

async function startTabTriggeredBrowserDownload(fileName: string, mimeType: string, fileBytes: ArrayBuffer) {
  if (!chrome.scripting?.executeScript) {
    throw new Error('This browser does not support file save fallback injection.');
  }

  const tab = await activeTabGateway.getActiveCapturableTab();
  if (!tab) {
    throw new Error('No active browser tab is available to receive the file.');
  }

  const safeFileName = sanitizeDownloadFileName(fileName);
  const byteArray = Array.from(new Uint8Array(fileBytes));
  const [result] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: (downloadFileName: string, downloadMimeType: string, bytes: number[]) => {
      const blob = new Blob([new Uint8Array(bytes)], { type: downloadMimeType || 'application/octet-stream' });
      const objectUrl = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = objectUrl;
      anchor.download = downloadFileName;
      anchor.rel = 'noopener';
      anchor.style.display = 'none';
      (document.body ?? document.documentElement).appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 15_000);
      return {
        ok: true,
        savedPath: downloadFileName,
        message: `${downloadFileName} save was triggered in the browser tab.`,
      };
    },
    args: [safeFileName, mimeType || 'application/octet-stream', byteArray],
  });

  if (!result?.result?.ok) {
    throw new Error(result?.result?.message || 'The browser tab could not start the file save flow.');
  }

  return result.result;
}

async function startBrowserDownload(objectUrl: string, fileName: string, mimeType: string, fileBytes: ArrayBuffer) {
  if (browserPlatform.capabilities.downloadsApi) {
    try {
      return await startManagedBrowserDownload(objectUrl, fileName);
    } catch (error) {
      debugError('background', 'Managed browser download failed; falling back to tab-triggered save.', error);
    }
  }

  return startTabTriggeredBrowserDownload(fileName, mimeType, fileBytes);
}

async function forwardPopupFileUploadToBridge(payload: {
  uploadId: string;
  fileName: string;
  mimeType: string;
  byteCount: number;
  fileBytesBase64: string;
  pageUrl: string | null;
  tabId: number | null;
  sentAt: string;
  text: string;
}) {
  await ensureBridge();

  return await new Promise<{ ok: boolean; message?: string }>((resolve, reject) => {
    chrome.runtime.sendMessage({ type: 'popup-file-upload', payload }, (response) => {
      const runtimeError = chrome.runtime.lastError;
      if (runtimeError) {
        reject(new Error(runtimeError.message));
        return;
      }

      resolve((response ?? { ok: false, message: 'No response from offscreen bridge.' }) as {
        ok: boolean;
        message?: string;
      });
    });
  });
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

  if (message?.type === 'reconnect-bridge') {
    void bridgeLifecycleService.forceReconnect()
      .then(() => sendResponse({ ok: true }))
      .catch((error) => {
        const messageText = error instanceof Error ? error.message : 'Bridge reconnect failed.';
        debugError('background', 'Bridge reconnect request failed.', messageText);
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

  if (message?.type === 'bridge-screen-share-click') {
    void dispatchScreenShareClick(Number(message.normalizedX), Number(message.normalizedY))
      .then((result) => sendResponse({ ...result, ok: true }))
      .catch((error) => {
        const messageText = error instanceof Error ? error.message : 'Screen share click failed.';
        debugError('background', 'Bridge screen share click request failed.', messageText);
        sendResponse({ ok: false, message: messageText });
      });
    return true;
  }

  if (message?.type === 'bridge-screen-share-paste') {
    void dispatchScreenSharePaste(String(message.text ?? ''))
      .then((result) => sendResponse({ ...result, ok: true }))
      .catch((error) => {
        const messageText = error instanceof Error ? error.message : 'Screen share paste failed.';
        debugError('background', 'Bridge screen share paste request failed.', messageText);
        sendResponse({ ok: false, message: messageText });
      });
    return true;
  }

  if (message?.type === 'bridge-screen-share-input') {
    void dispatchScreenShareInput(message.payload ?? {})
      .then((result) => sendResponse({ ...result, ok: true }))
      .catch((error) => {
        const messageText = error instanceof Error ? error.message : 'Screen share input failed.';
        debugError('background', 'Bridge screen share input request failed.', messageText);
        sendResponse({ ok: false, message: messageText });
      });
    return true;
  }

  if (message?.type === 'bridge-screen-share-key') {
    void dispatchScreenShareKey(message.payload ?? {})
      .then((result) => sendResponse({ ...result, ok: true }))
      .catch((error) => {
        const messageText = error instanceof Error ? error.message : 'Screen share key failed.';
        debugError('background', 'Bridge screen share key request failed.', messageText);
        sendResponse({ ok: false, message: messageText });
      });
    return true;
  }

  if (message?.type === 'bridge-browser-download') {
    void startBrowserDownload(
      String(message.objectUrl ?? ''),
      String(message.fileName ?? 'download.bin'),
      String(message.mimeType ?? 'application/octet-stream'),
      message.fileBytes instanceof ArrayBuffer ? message.fileBytes : new ArrayBuffer(0)
    )
      .then((result) => sendResponse({ ...result, ok: true }))
      .catch((error) => {
        const messageText = error instanceof Error ? error.message : 'Browser download failed.';
        debugError('background', 'Bridge browser download request failed.', messageText);
        sendResponse({ ok: false, message: messageText });
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

  if (message?.type === 'popup-file-send') {
    void (async () => {
      try {
        const fileName = typeof message.payload?.fileName === 'string' && message.payload.fileName.trim()
          ? message.payload.fileName.trim()
          : 'client-upload.bin';
        const mimeType = typeof message.payload?.mimeType === 'string' && message.payload.mimeType.trim()
          ? message.payload.mimeType.trim()
          : 'application/octet-stream';
        const fileBytesBase64 = typeof message.payload?.fileBytesBase64 === 'string'
          ? message.payload.fileBytesBase64
          : '';
        const popupText = typeof message.payload?.text === 'string' ? message.payload.text : '';
        const pageUrl = sender.tab?.url ?? (typeof message.payload?.pageUrl === 'string' ? message.payload.pageUrl : null);
        const tabId = sender.tab?.id ?? (typeof message.payload?.tabId === 'number' ? message.payload.tabId : null);
        const sentAt = new Date().toISOString();
        if (!fileBytesBase64) {
          throw new Error('The popup file upload did not contain a base64 binary payload.');
        }
        debugLog('background', 'Forwarding popup file upload to bridge.', { fileName, mimeType, base64Length: fileBytesBase64.length, textLength: popupText.length });

        const response = await forwardPopupFileUploadToBridge({
          uploadId: typeof message.payload?.uploadId === 'string' && message.payload.uploadId
            ? message.payload.uploadId
            : crypto.randomUUID(),
          fileName,
          mimeType,
          byteCount: typeof message.payload?.byteCount === 'number' ? message.payload.byteCount : 0,
          fileBytesBase64,
          pageUrl,
          tabId,
          sentAt,
          text: popupText,
        });

        if (!response.ok) {
          throw new Error(response.message || 'The offscreen bridge rejected the popup file upload.');
        }

        // Mirror the accompanying text into the popup-message ledger so the GUI's
        // "Latest popup message" shows it alongside the file in the Client Uploads list.
        if (popupText.length > 0) {
          const textPayload = { text: popupText, pageUrl, tabId, sentAt };
          recordPopupMessage(textPayload);
          notifyPopupMessage(textPayload);
        }

        sendResponse({ ok: true, message: response.message ?? `${fileName} sent to the desktop control center.` });
      } catch (error) {
        const messageText = error instanceof Error ? error.message : 'Popup file upload failed.';
        debugError('background', 'Popup file upload failed.', messageText);
        sendResponse({ ok: false, message: messageText });
      }
    })();
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

  if (message?.type === 'screen-share-get-tab-stream-id') {
    void (async () => {
      try {
        const consumerTabId = sender?.tab?.id;
        if (typeof consumerTabId !== 'number') {
          throw new Error('Screen share popup tab id is unavailable.');
        }

        // Pick the active tab in a normal (non-popup) window to capture.
        const candidateTabs = await chrome.tabs.query({ active: true, windowType: 'normal' });
        const usable = candidateTabs.find((tab) => {
          if (!tab.id || !tab.url) {
            return false;
          }
          return !BLOCKED_PROTOCOL_PREFIXES.some((prefix) => tab.url!.startsWith(prefix));
        });

        let targetTab = usable;
        if (!targetTab) {
          const fallback = await activeTabGateway.getActiveCapturableTab();
          if (fallback?.id) {
            targetTab = fallback;
          }
        }

        if (!targetTab?.id) {
          throw new Error('No shareable browser tab is open. Switch to a regular browser tab and try again.');
        }

        if (!chrome.tabCapture?.getMediaStreamId) {
          throw new Error('This Chrome build does not expose chrome.tabCapture. Update Chrome to use the silent capture flow.');
        }

        const streamId: string = await new Promise((resolve, reject) => {
          chrome.tabCapture.getMediaStreamId(
            { consumerTabId, targetTabId: targetTab!.id! },
            (id?: string) => {
              const runtimeError = chrome.runtime.lastError;
              if (runtimeError) {
                reject(new Error(runtimeError.message));
                return;
              }
              if (!id) {
                reject(new Error('chrome.tabCapture returned an empty stream id.'));
                return;
              }
              resolve(id);
            }
          );
        });

        // Remember the captured tab so click/keyboard input is routed there.
        latestScreenShareOverlayTabId = targetTab.id;

        sendResponse({
          ok: true,
          streamId,
          targetTabId: targetTab.id,
          sourceLabel: targetTab.title || targetTab.url || 'Browser tab'
        });
      } catch (error) {
        const messageText = error instanceof Error ? error.message : 'Tab capture stream id lookup failed.';
        debugError('background', 'Tab capture stream id lookup failed.', messageText);
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
