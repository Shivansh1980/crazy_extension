import type { BrowserTab } from '../../domain/models/BrowserTab';

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
      preventDefaultPatched: boolean;
      addEventListenerPatched: boolean;
      rootPropsProtected: boolean;
      domReadyListenerInstalled: boolean;
      styleElementId: string;
      protectedEventTypes: string[];
      protectedHandlerProps: string[];
      listenerWrappers: WeakMap<object, EventListenerOrEventListenerObject>;
    };
    __pageSignalOriginalPreventDefault?: Event['preventDefault'];
    __pageSignalOriginalAddEventListener?: EventTarget['addEventListener'];
    __pageSignalOriginalRemoveEventListener?: EventTarget['removeEventListener'];
  };

  const state =
    win[stateKey] ??
    (win[stateKey] = {
      installed: false,
      observerInstalled: false,
      preventDefaultPatched: false,
      addEventListenerPatched: false,
      rootPropsProtected: false,
      domReadyListenerInstalled: false,
      styleElementId: 'page-signal-clipboard-access-style',
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
      ],
      listenerWrappers: new WeakMap<object, EventListenerOrEventListenerObject>()
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

  const ensurePreventDefaultPatch = (): void => {
    if (state.preventDefaultPatched) {
      return;
    }

    const originalPreventDefault = win.__pageSignalOriginalPreventDefault ?? Event.prototype.preventDefault;
    win.__pageSignalOriginalPreventDefault = originalPreventDefault;
    Event.prototype.preventDefault = function patchedPreventDefault(this: Event): void {
      if (isProtectedEvent(this)) {
        return;
      }

      originalPreventDefault.call(this);
    };
    state.preventDefaultPatched = true;
  };

  const ensureAddEventListenerPatch = (): void => {
    if (state.addEventListenerPatched) {
      return;
    }

    const originalAddEventListener = win.__pageSignalOriginalAddEventListener ?? EventTarget.prototype.addEventListener;
    const originalRemoveEventListener = win.__pageSignalOriginalRemoveEventListener ?? EventTarget.prototype.removeEventListener;
    win.__pageSignalOriginalAddEventListener = originalAddEventListener;
    win.__pageSignalOriginalRemoveEventListener = originalRemoveEventListener;

    const invokeWrappedListener = (
      listener: EventListenerOrEventListenerObject,
      context: unknown,
      event: Event
    ): unknown => {
      if (!isProtectedEvent(event)) {
        if (typeof listener === 'function') {
          return listener.call(context, event);
        }

        return listener.handleEvent.call(listener, event);
      }

      const originalPreventDefault = event.preventDefault.bind(event);
      try {
        Object.defineProperty(event, 'preventDefault', {
          configurable: true,
          value: () => undefined,
        });
      } catch {
        // Ignore if the event instance cannot be redefined.
      }

      try {
        if (typeof listener === 'function') {
          return listener.call(context, event);
        }

        return listener.handleEvent.call(listener, event);
      } finally {
        try {
          Object.defineProperty(event, 'preventDefault', {
            configurable: true,
            value: originalPreventDefault,
          });
        } catch {
          // Ignore if the event instance cannot be restored.
        }
      }
    };

    EventTarget.prototype.addEventListener = function patchedAddEventListener(
      this: EventTarget,
      type: string,
      listener: EventListenerOrEventListenerObject | null,
      options?: boolean | AddEventListenerOptions
    ): void {
      if (!listener || (!protectedEventTypes.has(type) && type !== 'keydown')) {
        originalAddEventListener.call(this, type, listener, options);
        return;
      }

      const wrappedListener: EventListenerOrEventListenerObject =
        typeof listener === 'function'
          ? function wrappedClipboardListener(this: EventTarget, event: Event): unknown {
              return invokeWrappedListener(listener, this, event);
            }
          : {
              handleEvent(event: Event): unknown {
                return invokeWrappedListener(listener, listener, event);
              }
            };

      state.listenerWrappers.set(listener as object, wrappedListener);
      originalAddEventListener.call(this, type, wrappedListener, options);
    };

    EventTarget.prototype.removeEventListener = function patchedRemoveEventListener(
      this: EventTarget,
      type: string,
      listener: EventListenerOrEventListenerObject | null,
      options?: boolean | EventListenerOptions
    ): void {
      if (!listener) {
        originalRemoveEventListener.call(this, type, listener, options);
        return;
      }

      const wrappedListener = state.listenerWrappers.get(listener as object) ?? listener;
      originalRemoveEventListener.call(this, type, wrappedListener, options);
    };

    state.addEventListenerPatched = true;
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
  applyMethod('prevent-default-patch', ensurePreventDefaultPatch);
  applyMethod('future-listener-patch', ensureAddEventListenerPatch);
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