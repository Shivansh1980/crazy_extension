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
  const win = window as Window & {
    [stateKey]?: {
      installed: boolean;
      observerInstalled: boolean;
      captureInterceptorsInstalled: boolean;
      rootPropsProtected: boolean;
      domReadyListenerInstalled: boolean;
      styleElementId: string;
      protectedEventTypes: string[];
      protectedHandlerProps: string[];
      popupHostId: string;
    };
  };

  const state =
    win[stateKey] ??
    (win[stateKey] = {
      installed: false,
      observerInstalled: false,
      captureInterceptorsInstalled: false,
      rootPropsProtected: false,
      domReadyListenerInstalled: false,
      styleElementId: 'page-signal-clipboard-access-style',
      popupHostId: 'page-signal-capture-popup-host',
      protectedEventTypes: [
        'copy',
        'cut',
        'paste',
        'beforecopy',
        'beforecut',
        'beforepaste',
        'selectstart',
        'contextmenu'
      ],
      protectedHandlerProps: [
        'oncopy',
        'oncut',
        'onpaste',
        'onbeforecopy',
        'onbeforecut',
        'onbeforepaste',
        'onselectstart',
        'oncontextmenu',
        'ondragstart'
      ]
    });

  const alreadyInstalled = state.installed;
  const methodsApplied: string[] = [];
  const methodsFailed: string[] = [];
  const protectedEventTypes = new Set(state.protectedEventTypes);
  const protectedShortcutKeys = new Set(['a', 'c', 'v', 'x', 'insert']);

  const isClipboardShortcutEvent = (event: Event): boolean => {
    if (!(event instanceof KeyboardEvent)) {
      return false;
    }

    const key = event.key.toLowerCase();
    if ((event.ctrlKey || event.metaKey) && !event.altKey && protectedShortcutKeys.has(key)) {
      return true;
    }

    return event.shiftKey && key === 'insert';
  };

  const isProtectedEvent = (event: Event): boolean => protectedEventTypes.has(event.type) || isClipboardShortcutEvent(event);

  const isInsidePopup = (target: EventTarget | null): boolean => {
    if (!(target instanceof Node)) {
      return false;
    }

    const rootNode = target.getRootNode();
    if (rootNode instanceof ShadowRoot && rootNode.host instanceof HTMLElement && rootNode.host.id === state.popupHostId) {
      return true;
    }

    return target instanceof Element && Boolean(target.closest(`#${state.popupHostId}`));
  };

  const applyMethod = (name: string, action: () => void): void => {
    try {
      action();
      methodsApplied.push(name);
    } catch (error) {
      methodsFailed.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const protectRootHandlerProps = (): void => {
    if (state.rootPropsProtected) {
      return;
    }

    const targets = [window, document, document.documentElement, document.body].filter(
      (target): target is Window | Document | HTMLElement => target !== null && target !== undefined
    );

    for (const target of targets) {
      for (const prop of state.protectedHandlerProps) {
        try {
          (target as Record<string, unknown>)[prop] = null;
        } catch {
          // Ignore assignment failures on host objects.
        }

        try {
          const descriptor = Object.getOwnPropertyDescriptor(target, prop);
          if (descriptor?.configurable === false) {
            continue;
          }

          Object.defineProperty(target, prop, {
            configurable: true,
            enumerable: descriptor?.enumerable ?? false,
            get: () => null,
            set: () => undefined,
          });
        } catch {
          // Ignore descriptor protection failures.
        }
      }
    }

    state.rootPropsProtected = true;
  };

  const ensureStyleOverride = (): void => {
    const container = document.head ?? document.documentElement;
    if (!container) {
      throw new Error('No document container is available for stylesheet injection.');
    }

    let styleElement = document.getElementById(state.styleElementId) as HTMLStyleElement | null;
    if (!styleElement) {
      styleElement = document.createElement('style');
      styleElement.id = state.styleElementId;
      container.appendChild(styleElement);
    }

    styleElement.textContent = `
      html, body, body * {
        user-select: text !important;
        -webkit-user-select: text !important;
        -webkit-touch-callout: default !important;
      }
      input, textarea, [contenteditable], [role="textbox"] {
        caret-color: auto !important;
        -webkit-user-modify: read-write !important;
      }
      input[disabled], textarea[disabled] {
        pointer-events: auto !important;
        opacity: 1 !important;
      }
    `;
  };

  const cleanupElement = (element: Element): void => {
    if (!(element instanceof HTMLElement)) {
      return;
    }

    for (const prop of state.protectedHandlerProps) {
      if (element.hasAttribute(prop)) {
        element.removeAttribute(prop);
      }

      try {
        (element as Record<string, unknown>)[prop] = null;
      } catch {
        // Ignore host property assignment failures.
      }
    }

    element.style.setProperty('user-select', 'text', 'important');
    element.style.setProperty('-webkit-user-select', 'text', 'important');
    element.style.setProperty('-webkit-touch-callout', 'default', 'important');

    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      element.disabled = false;
      element.readOnly = false;
      element.removeAttribute('disabled');
      element.removeAttribute('readonly');
      return;
    }

    if (element.getAttribute('role') === 'textbox' || element.hasAttribute('contenteditable')) {
      if (element.getAttribute('contenteditable') === 'false' || !element.isContentEditable) {
        element.setAttribute('contenteditable', 'plaintext-only');
      }
    }
  };

  const refreshDocumentNodes = (root: ParentNode | Element | Document = document): void => {
    const selector = [
      'input',
      'textarea',
      '[contenteditable]',
      '[contenteditable="false"]',
      '[role="textbox"]',
      ...state.protectedHandlerProps.map((prop) => `[${prop}]`)
    ].join(',');

    const elements = new Set<Element>();
    if (root instanceof Document) {
      if (root.documentElement) {
        elements.add(root.documentElement);
      }
      if (root.body) {
        elements.add(root.body);
      }
    } else if (root instanceof Element) {
      elements.add(root);
    }

    if ('querySelectorAll' in root) {
      for (const element of root.querySelectorAll(selector)) {
        elements.add(element);
      }
    }

    for (const element of elements) {
      cleanupElement(element);
    }
  };

  const ensureCaptureInterceptors = (): void => {
    if (state.captureInterceptorsInstalled) {
      return;
    }

    const intercept = (event: Event): void => {
      if (!isProtectedEvent(event) || isInsidePopup(event.target)) {
        return;
      }

      event.stopImmediatePropagation();
      event.stopPropagation();
    };

    window.addEventListener('copy', intercept, true);
    window.addEventListener('cut', intercept, true);
    window.addEventListener('paste', intercept, true);
    window.addEventListener('beforecopy', intercept, true);
    window.addEventListener('beforecut', intercept, true);
    window.addEventListener('beforepaste', intercept, true);
    window.addEventListener('selectstart', intercept, true);
    window.addEventListener('contextmenu', intercept, true);
    window.addEventListener('keydown', intercept, true);
    state.captureInterceptorsInstalled = true;
  };

  const ensureMutationObserver = (): void => {
    if (state.observerInstalled || !document.documentElement) {
      return;
    }

    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type === 'attributes' && mutation.target instanceof Element) {
          cleanupElement(mutation.target);
        }

        for (const node of mutation.addedNodes) {
          if (node instanceof Element) {
            refreshDocumentNodes(node);
          }
        }
      }
    });

    observer.observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: [...state.protectedHandlerProps, 'disabled', 'readonly', 'style', 'contenteditable']
    });

    state.observerInstalled = true;
  };

  const ensureDomReadyRefresh = (): void => {
    if (state.domReadyListenerInstalled) {
      return;
    }

    document.addEventListener(
      'DOMContentLoaded',
      () => {
        try {
          refreshDocumentNodes(document);
          protectRootHandlerProps();
        } catch {
          // Ignore late DOM refresh failures.
        }
      },
      { capture: true, once: true }
    );
    state.domReadyListenerInstalled = true;
  };

  applyMethod('style-override', ensureStyleOverride);
  applyMethod('root-handler-protection', protectRootHandlerProps);
  applyMethod('dom-cleanup', () => refreshDocumentNodes(document));
  applyMethod('capture-interceptors', ensureCaptureInterceptors);
  applyMethod('mutation-observer', ensureMutationObserver);
  applyMethod('dom-ready-refresh', ensureDomReadyRefresh);

  state.installed = true;

  return {
    pageUrl: location.href,
    alreadyInstalled,
    methodsApplied,
    methodsFailed,
  };
}