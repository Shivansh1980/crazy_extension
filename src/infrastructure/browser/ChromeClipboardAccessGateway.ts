import type { BrowserTab } from '../../domain/models/BrowserTab';
import { getBrowserCapabilities } from '../../shared/browserCapabilities';
import { ExtensionError } from '../../shared/errors';

export interface ClipboardAccessEnableResult {
  tabId: number;
  pageUrl: string;
  frameCount: number;
  alreadyInstalled: boolean;
  methodsApplied: string[];
  methodsFailed: string[];
}

interface FrameClipboardAccessEnableResult {
  pageUrl: string;
  alreadyInstalled: boolean;
  methodsApplied: string[];
  methodsFailed: string[];
}

export class ChromeClipboardAccessGateway {
  async enable(tab: BrowserTab): Promise<ClipboardAccessEnableResult> {
    const capabilities = getBrowserCapabilities();
    if (!capabilities.scriptingApi) {
      throw new ExtensionError('This browser does not support script injection required for page copy and paste enablement.');
    }

    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      world: 'MAIN',
      func: enableClipboardAccessInPage,
    });

    const normalizedResults = results
      .map((result) => this.normalizeFrameResult(result.result, tab.url))
      .filter((result): result is FrameClipboardAccessEnableResult => result !== null);

    return {
      tabId: tab.id,
      pageUrl: tab.url,
      frameCount: normalizedResults.length,
      alreadyInstalled: normalizedResults.length > 0 && normalizedResults.every((result) => result.alreadyInstalled),
      methodsApplied: Array.from(new Set(normalizedResults.flatMap((result) => result.methodsApplied))),
      methodsFailed: normalizedResults.flatMap((result) => result.methodsFailed),
    };
  }

  private normalizeFrameResult(result: unknown, fallbackUrl: string): FrameClipboardAccessEnableResult | null {
    if (typeof result !== 'object' || result === null) {
      return null;
    }

    const record = result as Record<string, unknown>;
    return {
      pageUrl: typeof record.pageUrl === 'string' ? record.pageUrl : fallbackUrl,
      alreadyInstalled: Boolean(record.alreadyInstalled),
      methodsApplied: Array.isArray(record.methodsApplied)
        ? record.methodsApplied.filter((value): value is string => typeof value === 'string')
        : [],
      methodsFailed: Array.isArray(record.methodsFailed)
        ? record.methodsFailed.filter((value): value is string => typeof value === 'string')
        : [],
    };
  }
}

function enableClipboardAccessInPage(): FrameClipboardAccessEnableResult {
  const stateKey = '__pageSignalClipboardAccessState';
  const styleElementId = 'page-signal-clipboard-access-style';
  const popupHostId = 'page-signal-capture-popup-host';
  const legacyProtectedHandlerProps = [
    'oncopy',
    'oncut',
    'onpaste',
    'onbeforecopy',
    'onbeforecut',
    'onbeforepaste',
    'onselectstart',
    'oncontextmenu',
    'ondragstart'
  ];
  const win = window as Window & {
    [stateKey]?: Record<string, unknown>;
  };

  const existingState = win[stateKey];
  const legacyStateDetected = Boolean(
    existingState &&
      existingState.installed === true &&
      existingState.compatibilityMode !== 'passive'
  );
  const alreadyInstalled = Boolean(
    existingState &&
      existingState.installed === true &&
      existingState.compatibilityMode === 'passive'
  );
  const methodsApplied: string[] = [];
  const methodsFailed: string[] = [];

  const applyMethod = (name: string, action: () => void): void => {
    try {
      action();
      methodsApplied.push(name);
    } catch (error) {
      methodsFailed.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const removeLegacyStyleOverride = (): void => {
    document.getElementById(styleElementId)?.remove();
  };

  const releaseLegacyRootHandlerProps = (): void => {
    const targets: Array<Window | Document | HTMLElement> = [window, document];
    if (document.documentElement) {
      targets.push(document.documentElement);
    }
    if (document.body) {
      targets.push(document.body);
    }

    for (const target of targets) {
      for (const prop of legacyProtectedHandlerProps) {
        const descriptor = Object.getOwnPropertyDescriptor(target, prop);
        if (!descriptor?.configurable || typeof descriptor.get !== 'function' || typeof descriptor.set !== 'function') {
          continue;
        }

        let descriptorValue: unknown;
        try {
          descriptorValue = descriptor.get.call(target);
        } catch {
          descriptorValue = undefined;
        }

        if (descriptorValue === null) {
          delete (target as unknown as Record<string, unknown>)[prop];
        }
      }
    }
  };

  const neutralizeLegacyState = (): void => {
    if (!existingState) {
      return;
    }

    // Older builds read these arrays from the shared state object during DOM cleanup. Emptying
    // them is a best-effort way to reduce further mutation damage until the page is refreshed.
    existingState.protectedEventTypes = [];
    existingState.protectedHandlerProps = [];
  };

  if (legacyStateDetected) {
    applyMethod('legacy-style-cleanup', removeLegacyStyleOverride);
    applyMethod('legacy-root-handler-cleanup', releaseLegacyRootHandlerProps);
    applyMethod('legacy-state-neutralized', neutralizeLegacyState);
  }

  win[stateKey] = {
    installed: true,
    compatibilityMode: 'passive',
    styleElementId,
    popupHostId,
    updatedAt: new Date().toISOString()
  };

  // Intentionally do not add copy/paste/keydown listeners, override page handlers, edit
  // contenteditable state, or mutate disabled/readOnly fields. The extension only needs the
  // offscreen document for GUI-driven clipboard writes; page-level paste must remain owned by
  // the site so rich paste flows such as ChatGPT images continue to work.
  applyMethod('passive-page-compatibility', () => undefined);

  return {
    pageUrl: location.href,
    alreadyInstalled,
    methodsApplied,
    methodsFailed,
  };
}
