import type { BrowserTab } from '../../domain/models/BrowserTab';

export type PagePopupState = 'open' | 'minimized' | 'closed' | 'unknown';

export interface PagePopupStatus {
  exists: boolean;
  state: PagePopupState;
  tabId: number | null;
  pageUrl: string | null;
  updatedAt: string;
  textLength: number;
}

export interface PagePopupShowResult extends PagePopupStatus {
  action: 'created' | 'updated' | 'restored';
}

export class ChromePagePopupGateway {
  async show(tab: BrowserTab, text: string): Promise<PagePopupShowResult> {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: injectOrUpdatePopupInPage,
      args: [text, tab.id, tab.url]
    });

    const firstResult = results[0]?.result;
    return this.normalizeShowResult(firstResult, tab);
  }

  async getStatus(tab: BrowserTab): Promise<PagePopupStatus> {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: readPopupStatusInPage,
      args: [tab.id, tab.url]
    });

    const firstResult = results[0]?.result;
    return this.normalizeStatus(firstResult, tab);
  }

  async close(tab: BrowserTab): Promise<PagePopupStatus> {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: closePopupInPage,
      args: [tab.id, tab.url]
    });

    const firstResult = results[0]?.result;
    return this.normalizeStatus(firstResult, tab);
  }

  private normalizeShowResult(result: unknown, tab: BrowserTab): PagePopupShowResult {
    const normalized = this.normalizeStatus(result, tab);
    const action =
      typeof result === 'object' &&
      result !== null &&
      'action' in result &&
      (result.action === 'created' || result.action === 'updated' || result.action === 'restored')
        ? result.action
        : 'updated';

    return {
      ...normalized,
      action
    };
  }

  private normalizeStatus(result: unknown, tab: BrowserTab): PagePopupStatus {
    if (typeof result === 'object' && result !== null) {
      const resultRecord = result as Record<string, unknown>;
      const state = resultRecord.state;
      return {
        exists: Boolean(resultRecord.exists),
        state: state === 'open' || state === 'minimized' || state === 'closed' ? state : 'unknown',
        tabId: typeof resultRecord.tabId === 'number' ? resultRecord.tabId : tab.id,
        pageUrl: typeof resultRecord.pageUrl === 'string' ? resultRecord.pageUrl : tab.url,
        updatedAt: typeof resultRecord.updatedAt === 'string' ? resultRecord.updatedAt : new Date().toISOString(),
        textLength: typeof resultRecord.textLength === 'number' ? resultRecord.textLength : 0
      };
    }

    return {
      exists: false,
      state: 'unknown',
      tabId: tab.id,
      pageUrl: tab.url,
      updatedAt: new Date().toISOString(),
      textLength: 0
    };
  }
}

function injectOrUpdatePopupInPage(text: string, tabId: number, pageUrl: string): PagePopupShowResult {
  const popupHostId = 'page-signal-capture-popup-host';
  const minimizedSizePx = 40;
  const defaultSizePx = 200;
  const minimumSizePx = 160;
  const defaultOpacity = 0.5;

  function updateMeta(textArea: HTMLTextAreaElement, meta: HTMLElement): void {
    const lineCount = textArea.value.length === 0 ? 0 : textArea.value.split(/\r\n|\r|\n/).length;
    meta.textContent = `${textArea.value.length} chars · ${lineCount} line${lineCount === 1 ? '' : 's'}`;
  }

  function sendRuntimeMessage(message: unknown): void {
    try {
      void chrome.runtime.sendMessage(message).catch(() => undefined);
    } catch {
      // Ignore runtime messaging failures inside the page popup.
    }
  }

  async function copyTextToClipboard(text: string): Promise<void> {
    if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
      try {
        await navigator.clipboard.write([
          new ClipboardItem({
            'text/plain': new Blob([text], { type: 'text/plain' })
          })
        ]);
        return;
      } catch {
        // Fall through to the next clipboard strategy.
      }
    }

    if (navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(text);
        return;
      } catch {
        // Fall through to the next clipboard strategy.
      }
    }

    if (copyWithTextarea(text) || copyWithContentEditable(text)) {
      return;
    }

    throw new Error('All clipboard copy strategies failed.');
  }

  function copyWithTextarea(text: string): boolean {
    const container = document.body ?? document.documentElement;
    if (!container) {
      return false;
    }

    const activeElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', 'true');
    textarea.setAttribute('aria-hidden', 'true');
    textarea.style.position = 'fixed';
    textarea.style.top = '0';
    textarea.style.left = '0';
    textarea.style.width = '1px';
    textarea.style.height = '1px';
    textarea.style.opacity = '0';
    textarea.style.pointerEvents = 'none';
    textarea.style.zIndex = '-1';
    container.appendChild(textarea);

    try {
      textarea.focus();
      textarea.select();
      textarea.setSelectionRange(0, textarea.value.length);
      return document.execCommand('copy');
    } catch {
      return false;
    } finally {
      textarea.remove();
      activeElement?.focus({ preventScroll: true });
    }
  }

  function copyWithContentEditable(text: string): boolean {
    const container = document.body ?? document.documentElement;
    if (!container) {
      return false;
    }

    const selection = window.getSelection();
    const existingRanges = selection ? Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index).cloneRange()) : [];
    const activeElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;

    const editable = document.createElement('div');
    editable.contentEditable = 'true';
    editable.setAttribute('aria-hidden', 'true');
    editable.style.position = 'fixed';
    editable.style.top = '0';
    editable.style.left = '0';
    editable.style.opacity = '0';
    editable.style.pointerEvents = 'none';
    editable.style.whiteSpace = 'pre-wrap';
    editable.textContent = text;
    container.appendChild(editable);

    try {
      const range = document.createRange();
      range.selectNodeContents(editable);
      selection?.removeAllRanges();
      selection?.addRange(range);
      editable.focus();
      return document.execCommand('copy');
    } catch {
      return false;
    } finally {
      selection?.removeAllRanges();
      for (const range of existingRanges) {
        selection?.addRange(range);
      }
      editable.remove();
      activeElement?.focus({ preventScroll: true });
    }
  }

  function getTextLength(host: HTMLElement): number {
    return host.shadowRoot?.querySelector<HTMLTextAreaElement>('[data-role="content"]')?.value.length ?? 0;
  }

  function buildPopupStatus(host: HTMLElement, popupTabId: number | null, popupPageUrl: string, textLength: number): PagePopupStatus {
    const state =
      host.dataset.popupState === 'minimized'
        ? 'minimized'
        : host.dataset.popupState === 'closed'
          ? 'closed'
          : 'open';
    return {
      exists: state !== 'closed',
      state,
      tabId: popupTabId,
      pageUrl: popupPageUrl,
      updatedAt: new Date().toISOString(),
      textLength
    };
  }

  function sendPopupStatus(host: HTMLElement, popupTabId: number | null, popupPageUrl: string, textLength?: number): void {
    sendRuntimeMessage({
      type: 'popup-status-update',
      status: buildPopupStatus(host, popupTabId, popupPageUrl, textLength ?? getTextLength(host))
    });
  }

  function setPopupState(
    host: HTMLElement,
    state: 'open' | 'minimized' | 'closed',
    detail?: { tabId?: number; pageUrl?: string; textLength?: number }
  ): void {
    const shell = host.shadowRoot?.querySelector<HTMLElement>('[data-role="shell"]');
    if (!shell) {
      return;
    }

    host.dataset.popupState = state;
    host.style.display = state === 'closed' ? 'none' : 'block';
    if (state === 'minimized') {
      shell.classList.add('minimized');
    } else {
      shell.classList.remove('minimized');
    }

    sendPopupStatus(host, detail?.tabId ?? null, detail?.pageUrl ?? location.href, detail?.textLength);
  }

  function restorePopup(host: HTMLElement, shell: HTMLElement): void {
    host.style.display = 'block';
    host.style.width = `${defaultSizePx}px`;
    host.style.height = `${defaultSizePx}px`;
    host.style.minWidth = `${minimumSizePx}px`;
    host.style.minHeight = `${minimumSizePx}px`;
    host.style.resize = 'both';
    shell.classList.remove('minimized');
    setPopupState(host, 'open');
  }

  function attachDrag(handle: HTMLElement, host: HTMLElement, allowInteractiveTarget = false): void {
    handle.addEventListener('pointerdown', (event) => {
      if (!allowInteractiveTarget && (event.target as HTMLElement).closest('button, input')) {
        return;
      }

      event.preventDefault();
      let moved = false;
      const rect = host.getBoundingClientRect();
      host.style.left = `${rect.left}px`;
      host.style.top = `${rect.top}px`;
      host.style.right = 'auto';
      host.style.bottom = 'auto';

      const offsetX = event.clientX - rect.left;
      const offsetY = event.clientY - rect.top;

      const move = (moveEvent: PointerEvent) => {
        moved = true;
        host.style.left = `${Math.max(0, moveEvent.clientX - offsetX)}px`;
        host.style.top = `${Math.max(0, moveEvent.clientY - offsetY)}px`;
      };

      const stop = () => {
        handle.dataset.dragMoved = moved ? '1' : '0';
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', stop);
      };

      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', stop, { once: true });
    });
  }

  function isLightColor(color: string): boolean {
    const match = color.match(/\d+/g);
    if (!match || match.length < 3) {
      return true;
    }

    const [red = 255, green = 255, blue = 255] = match.slice(0, 3).map((value) => Number.parseInt(value, 10));
    const luminance = (0.2126 * red + 0.7152 * green + 0.0722 * blue) / 255;
    return luminance > 0.5;
  }

  function detectTheme() {
    const styles = getComputedStyle(document.body || document.documentElement);
    const backgroundColor = styles.backgroundColor || 'rgb(255, 255, 255)';
    const foreground = styles.color || '#111827';
    const fontFamily = styles.fontFamily || "'Segoe UI', system-ui, sans-serif";
    const light = isLightColor(backgroundColor);

    return {
      background: light ? 'rgba(255, 255, 255, 0.88)' : 'rgba(17, 24, 39, 0.88)',
      headerBackground: light ? 'rgba(255, 255, 255, 0.72)' : 'rgba(31, 41, 55, 0.82)',
      textareaBackground: light ? 'rgba(248, 250, 252, 0.92)' : 'rgba(17, 24, 39, 0.78)',
      controlBackground: light ? 'rgba(226, 232, 240, 0.9)' : 'rgba(55, 65, 81, 0.92)',
      border: light ? 'rgba(148, 163, 184, 0.35)' : 'rgba(148, 163, 184, 0.24)',
      foreground,
      accent: light ? '#2563eb' : '#38bdf8',
      accentSoft: light ? '#7c3aed' : '#6366f1',
      fontFamily,
    };
  }

  function createPopupHost(): HTMLElement {
    const host = document.createElement('div');
    host.id = popupHostId;
    host.dataset.popupState = 'open';
    host.style.position = 'fixed';
    host.style.top = '24px';
    host.style.right = '24px';
    host.style.width = `${defaultSizePx}px`;
    host.style.height = `${defaultSizePx}px`;
    host.style.minWidth = `${minimumSizePx}px`;
    host.style.minHeight = `${minimumSizePx}px`;
    host.style.zIndex = '2147483647';
    host.style.resize = 'both';
    host.style.overflow = 'hidden';
    host.style.boxSizing = 'border-box';
    host.style.opacity = String(defaultOpacity);
    return host;
  }

  function initializePopupDom(host: HTMLElement, shadowRoot: ShadowRoot): void {
    const theme = detectTheme();
    shadowRoot.innerHTML = `
      <style>
        :host {
          all: initial;
        }
        .shell {
          width: 100%;
          height: 100%;
          display: flex;
          flex-direction: column;
          border-radius: 18px;
          overflow: hidden;
          border: 1px solid ${theme.border};
          background: ${theme.background};
          color: ${theme.foreground};
          box-shadow: 0 24px 60px rgba(0, 0, 0, 0.24);
          backdrop-filter: blur(18px);
          font-family: ${theme.fontFamily};
        }
        .shell.minimized {
          width: ${minimizedSizePx}px;
          height: ${minimizedSizePx}px;
          border-radius: 999px;
        }
        .shell.minimized .header,
        .shell.minimized .body,
        .shell.minimized .footer {
          display: none;
        }
        .shell:not(.minimized) .launcher {
          display: none;
        }
        .launcher {
          width: 100%;
          height: 100%;
          display: grid;
          place-items: center;
          border: none;
          background: linear-gradient(135deg, ${theme.accent}, ${theme.accentSoft});
          color: #fff;
          font: inherit;
          cursor: pointer;
          font-size: 16px;
        }
        .header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 10px 12px;
          gap: 8px;
          background: ${theme.headerBackground};
          border-bottom: 1px solid ${theme.border};
          cursor: move;
          user-select: none;
        }
        .title {
          display: flex;
          flex-direction: column;
          gap: 2px;
          min-width: 0;
        }
        .title strong {
          font-size: 13px;
          font-weight: 700;
        }
        .title span {
          font-size: 11px;
          opacity: 0.72;
        }
        .controls {
          display: flex;
          gap: 5px;
        }
        button.control,
        button.copy,
        button.send {
          border: none;
          border-radius: 8px;
          background: ${theme.controlBackground};
          color: ${theme.foreground};
          padding: 4px 8px;
          font: inherit;
          font-size: 11px;
          line-height: 1.2;
          cursor: pointer;
        }
        button.control:hover,
        button.copy:hover,
        button.send:hover,
        .launcher:hover {
          filter: brightness(1.06);
        }
        .body {
          flex: 1;
          min-height: 0;
          padding: 10px 12px 0;
        }
        textarea {
          width: 100%;
          height: 100%;
          min-height: 0;
          resize: none;
          border: 1px solid ${theme.border};
          border-radius: 12px;
          background: ${theme.textareaBackground};
          color: ${theme.foreground};
          padding: 10px;
          box-sizing: border-box;
          font-family: Consolas, 'SFMono-Regular', 'Cascadia Code', monospace;
          font-size: 12px;
          line-height: 1.45;
          white-space: pre;
        }
        .footer {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 8px 10px 10px;
          gap: 8px;
        }
        .footer-right {
          display: flex;
          align-items: center;
          gap: 8px;
          flex-wrap: wrap;
          justify-content: flex-end;
        }
        .meta {
          font-size: 11px;
          opacity: 0.72;
        }
        .opacity-wrap {
          display: inline-flex;
          align-items: center;
          gap: 5px;
          font-size: 10px;
          opacity: 0.84;
        }
        .opacity-wrap input {
          width: 72px;
        }
      </style>
      <div class="shell" data-role="shell">
        <button class="launcher" data-role="launcher" title="Restore popup">✦</button>
        <div class="header" data-role="drag-handle">
          <div class="title">
            <strong>Shared Text</strong>
            <span>Always on top</span>
          </div>
          <div class="controls">
            <button class="control" data-role="minimize" title="Minimize">−</button>
            <button class="control" data-role="close" title="Close">×</button>
          </div>
        </div>
        <div class="body">
          <textarea data-role="content" spellcheck="false"></textarea>
        </div>
        <div class="footer">
          <span class="meta" data-role="meta">0 chars · 0 lines</span>
          <div class="footer-right">
            <label class="opacity-wrap">
              <span>Opacity</span>
              <input data-role="opacity" type="range" min="0.35" max="1" step="0.05" value="0.5" />
            </label>
            <button class="copy" data-role="copy">Copy</button>
            <button class="send" data-role="send">Send</button>
          </div>
        </div>
      </div>
    `;

    const shell = shadowRoot.querySelector<HTMLElement>('[data-role="shell"]');
    const dragHandle = shadowRoot.querySelector<HTMLElement>('[data-role="drag-handle"]');
    const minimizeButton = shadowRoot.querySelector<HTMLButtonElement>('[data-role="minimize"]');
    const closeButton = shadowRoot.querySelector<HTMLButtonElement>('[data-role="close"]');
    const launcher = shadowRoot.querySelector<HTMLButtonElement>('[data-role="launcher"]');
    const copyButton = shadowRoot.querySelector<HTMLButtonElement>('[data-role="copy"]');
    const sendButton = shadowRoot.querySelector<HTMLButtonElement>('[data-role="send"]');
    const opacityInput = shadowRoot.querySelector<HTMLInputElement>('[data-role="opacity"]');
    const textArea = shadowRoot.querySelector<HTMLTextAreaElement>('[data-role="content"]');
    const meta = shadowRoot.querySelector<HTMLElement>('[data-role="meta"]');

    if (!shell || !dragHandle || !minimizeButton || !closeButton || !launcher || !copyButton || !sendButton || !opacityInput || !textArea || !meta) {
      throw new Error('Popup controls could not be initialized.');
    }

    attachDrag(dragHandle, host);
    attachDrag(launcher, host, true);

    minimizeButton.addEventListener('click', () => {
      host.style.width = `${minimizedSizePx}px`;
      host.style.height = `${minimizedSizePx}px`;
      host.style.minWidth = `${minimizedSizePx}px`;
      host.style.minHeight = `${minimizedSizePx}px`;
      host.style.resize = 'none';
      shell.classList.add('minimized');
      setPopupState(host, 'minimized');
    });

    launcher.addEventListener('click', () => {
      if (launcher.dataset.dragMoved === '1') {
        launcher.dataset.dragMoved = '0';
        return;
      }

      restorePopup(host, shell);
    });

    closeButton.addEventListener('click', () => {
      setPopupState(host, 'closed', { tabId, pageUrl: location.href, textLength: textArea.value.length });
    });

    copyButton.addEventListener('click', async () => {
      const originalLabel = copyButton.textContent ?? 'Copy';
      copyButton.disabled = true;

      try {
        await copyTextToClipboard(textArea.value);
        copyButton.textContent = 'Copied';
      } catch {
        copyButton.textContent = 'Failed';
      } finally {
        window.setTimeout(() => {
          copyButton.textContent = originalLabel;
          copyButton.disabled = false;
        }, 900);
      }
    });

    sendButton.addEventListener('click', async () => {
      const originalLabel = sendButton.textContent ?? 'Send';
      sendButton.disabled = true;

      try {
        await chrome.runtime.sendMessage({
          type: 'popup-message-send',
          payload: {
            text: textArea.value,
            pageUrl: location.href,
          }
        });
        sendButton.textContent = 'Sent';
      } catch {
        sendButton.textContent = 'Retry';
      } finally {
        window.setTimeout(() => {
          sendButton.textContent = originalLabel;
          sendButton.disabled = false;
        }, 900);
      }
    });

    opacityInput.addEventListener('input', () => {
      host.style.opacity = opacityInput.value;
    });

    textArea.addEventListener('input', () => {
      updateMeta(textArea, meta);
      sendPopupStatus(host, tabId, location.href, textArea.value.length);
    });

    textArea.addEventListener('keydown', (event) => {
      if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'a') {
        event.stopPropagation();
      }
    });
  }

  const existingHost = document.getElementById(popupHostId) as HTMLElement | null;
  const action: PagePopupShowResult['action'] = existingHost
    ? existingHost.dataset.popupState === 'minimized' || existingHost.dataset.popupState === 'closed'
      ? 'restored'
      : 'updated'
    : 'created';
  const host = existingHost ?? createPopupHost();
  const shadowRoot = host.shadowRoot ?? host.attachShadow({ mode: 'open' });

  if (!shadowRoot.hasChildNodes()) {
    initializePopupDom(host, shadowRoot);
  }

  const textArea = shadowRoot.querySelector<HTMLTextAreaElement>('[data-role="content"]');
  const meta = shadowRoot.querySelector<HTMLElement>('[data-role="meta"]');

  if (!textArea || !meta) {
    throw new Error('Popup DOM initialization failed.');
  }

  const shouldPreserveExistingText = existingHost !== null && existingHost.dataset.popupState === 'closed' && text.length === 0;
  if (!shouldPreserveExistingText) {
    textArea.value = text;
  }
  updateMeta(textArea, meta);

  if (!existingHost) {
    document.documentElement.appendChild(host);
  }

  if (action === 'restored' || action === 'created') {
    setPopupState(host, 'open', { tabId, pageUrl, textLength: textArea.value.length });
  } else {
    sendPopupStatus(host, tabId, pageUrl, textArea.value.length);
  }

  return {
    action,
    ...buildPopupStatus(host, tabId, pageUrl, textArea.value.length)
  };
}

function readPopupStatusInPage(tabId: number, pageUrl: string): PagePopupStatus {
  const popupHostId = 'page-signal-capture-popup-host';
  const host = document.getElementById(popupHostId) as HTMLElement | null;
  if (!host) {
    return {
      exists: false,
      state: 'closed',
      tabId,
      pageUrl,
      updatedAt: new Date().toISOString(),
      textLength: 0
    };
  }

  const textLength = host.shadowRoot?.querySelector<HTMLTextAreaElement>('[data-role="content"]')?.value.length ?? 0;
  return {
    exists: host.dataset.popupState !== 'closed',
    state: host.dataset.popupState === 'minimized' ? 'minimized' : host.dataset.popupState === 'closed' ? 'closed' : 'open',
    tabId,
    pageUrl,
    updatedAt: new Date().toISOString(),
    textLength
  };
}

function closePopupInPage(tabId: number, pageUrl: string): PagePopupStatus {
  const popupHostId = 'page-signal-capture-popup-host';
  const host = document.getElementById(popupHostId) as HTMLElement | null;
  const textLength = host?.shadowRoot?.querySelector<HTMLTextAreaElement>('[data-role="content"]')?.value.length ?? 0;

  if (host) {
    host.dataset.popupState = 'closed';
    host.style.display = 'none';
  }

  return {
    exists: false,
    state: 'closed',
    tabId,
    pageUrl,
    updatedAt: new Date().toISOString(),
    textLength
  };
}