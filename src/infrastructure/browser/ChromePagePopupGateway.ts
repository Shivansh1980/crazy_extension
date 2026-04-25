import type { BrowserTab } from '../../domain/models/BrowserTab';
import { getBrowserCapabilities } from '../../shared/browserCapabilities';
import { ExtensionError } from '../../shared/errors';

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
    this.ensureScriptingSupport();
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: injectOrUpdatePopupInPage,
      args: [text, tab.id, tab.url]
    });

    const firstResult = results[0]?.result;
    return this.normalizeShowResult(firstResult, tab);
  }

  async getStatus(tab: BrowserTab): Promise<PagePopupStatus> {
    this.ensureScriptingSupport();
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: readPopupStatusInPage,
      args: [tab.id, tab.url]
    });

    const firstResult = results[0]?.result;
    return this.normalizeStatus(firstResult, tab);
  }

  async close(tab: BrowserTab): Promise<PagePopupStatus> {
    this.ensureScriptingSupport();
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

  private ensureScriptingSupport(): void {
    const capabilities = getBrowserCapabilities();
    if (!capabilities.scriptingApi) {
      throw new ExtensionError('This browser does not support script injection required for the page popup feature.');
    }
  }
}

function injectOrUpdatePopupInPage(text: string, tabId: number, pageUrl: string): PagePopupShowResult {
  const popupHostId = 'page-signal-capture-popup-host';
  const minimizedSizePx = 40;
  const defaultWidthPx = 280;
  const defaultHeightPx = 220;
  const minimumWidthPx = 220;
  const minimumHeightPx = 180;
  const defaultOpacity = 0.5;

  function updateMeta(textArea: HTMLTextAreaElement, meta: HTMLElement): void {
    const lineCount = textArea.value.length === 0 ? 0 : textArea.value.split(/\r\n|\r|\n/).length;
    meta.textContent = `${textArea.value.length} chars · ${lineCount} line${lineCount === 1 ? '' : 's'}`;
  }

  function updateSelectedFileLabel(label: HTMLElement, file: File | null): void {
    if (!file) {
      label.textContent = 'No file selected';
      label.dataset.empty = 'true';
      return;
    }

    label.textContent = file.name;
    label.dataset.empty = 'false';
  }

  function sendRuntimeMessage(message: unknown): void {
    try {
      void chrome.runtime.sendMessage(message).catch(() => undefined);
    } catch {
      // Ignore runtime messaging failures inside the page popup.
    }
  }

  type RgbColor = { red: number; green: number; blue: number };

  function clamp(value: number, minimum: number, maximum: number): number {
    return Math.min(Math.max(value, minimum), maximum);
  }

  function parseColor(value: string, fallback: string): RgbColor {
    const probe = document.createElement('span');
    probe.style.color = fallback;
    probe.style.color = value;
    const normalized = probe.style.color || fallback;
    const match = normalized.match(/\d+/g);
    if (!match || match.length < 3) {
      return parseColor(fallback, 'rgb(255, 255, 255)');
    }

    const [red = 255, green = 255, blue = 255] = match.slice(0, 3).map((part) => clamp(Number.parseInt(part, 10), 0, 255));
    return { red, green, blue };
  }

  function toRgb(color: RgbColor, alpha?: number): string {
    return alpha === undefined
      ? `rgb(${color.red}, ${color.green}, ${color.blue})`
      : `rgba(${color.red}, ${color.green}, ${color.blue}, ${alpha})`;
  }

  function mixColors(base: RgbColor, overlay: RgbColor, amount: number): RgbColor {
    const ratio = clamp(amount, 0, 1);
    return {
      red: Math.round(base.red + (overlay.red - base.red) * ratio),
      green: Math.round(base.green + (overlay.green - base.green) * ratio),
      blue: Math.round(base.blue + (overlay.blue - base.blue) * ratio),
    };
  }

  function getLuminance(color: RgbColor): number {
    const transform = (channel: number): number => {
      const normalized = channel / 255;
      return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
    };

    const red = transform(color.red);
    const green = transform(color.green);
    const blue = transform(color.blue);
    return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
  }

  function getContrastRatio(first: RgbColor, second: RgbColor): number {
    const firstLuminance = getLuminance(first);
    const secondLuminance = getLuminance(second);
    const lighter = Math.max(firstLuminance, secondLuminance);
    const darker = Math.min(firstLuminance, secondLuminance);
    return (lighter + 0.05) / (darker + 0.05);
  }

  function chooseReadableText(background: RgbColor, preferred: RgbColor): RgbColor {
    if (getContrastRatio(background, preferred) >= 4.5) {
      return preferred;
    }

    const black = { red: 17, green: 24, blue: 39 };
    const white = { red: 248, green: 250, blue: 252 };
    return getContrastRatio(background, black) >= getContrastRatio(background, white) ? black : white;
  }

  function applyTheme(host: HTMLElement): void {
    const pageStyles = getComputedStyle(document.body || document.documentElement);
    const rootStyles = getComputedStyle(document.documentElement);
    const pageBackground = parseColor(pageStyles.backgroundColor || rootStyles.backgroundColor || 'rgb(255, 255, 255)', 'rgb(255, 255, 255)');
    const pageForeground = parseColor(pageStyles.color || rootStyles.color || 'rgb(17, 24, 39)', 'rgb(17, 24, 39)');
    const pageAccent = parseColor(rootStyles.getPropertyValue('a') || pageStyles.color || 'rgb(37, 99, 235)', 'rgb(37, 99, 235)');
    const darkPage = getLuminance(pageBackground) < 0.45;

    const surface = darkPage
      ? mixColors(pageBackground, { red: 15, green: 23, blue: 42 }, 0.76)
      : mixColors(pageBackground, { red: 255, green: 255, blue: 255 }, 0.92);
    const header = darkPage
      ? mixColors(surface, { red: 255, green: 255, blue: 255 }, 0.06)
      : mixColors(surface, { red: 15, green: 23, blue: 42 }, 0.04);
    const editor = darkPage
      ? mixColors(surface, { red: 2, green: 6, blue: 23 }, 0.34)
      : mixColors(surface, { red: 248, green: 250, blue: 252 }, 0.72);
    const foreground = chooseReadableText(surface, pageForeground);
    const mutedForeground = mixColors(foreground, surface, darkPage ? 0.28 : 0.42);
    const controlBackground = darkPage
      ? mixColors(surface, { red: 255, green: 255, blue: 255 }, 0.09)
      : mixColors(surface, { red: 15, green: 23, blue: 42 }, 0.08);
    const border = darkPage
      ? mixColors(surface, { red: 148, green: 163, blue: 184 }, 0.32)
      : mixColors(surface, { red: 100, green: 116, blue: 139 }, 0.26);
    const accent = chooseReadableText(header, pageAccent);
    const accentSoft = darkPage
      ? mixColors(accent, { red: 96, green: 165, blue: 250 }, 0.28)
      : mixColors(accent, { red: 124, green: 58, blue: 237 }, 0.18);
    const fontFamily = pageStyles.fontFamily || rootStyles.fontFamily || "'Segoe UI', system-ui, sans-serif";

    host.style.setProperty('--popup-surface', toRgb(surface, 0.96));
    host.style.setProperty('--popup-surface-strong', toRgb(header, 0.98));
    host.style.setProperty('--popup-editor', toRgb(editor, 0.98));
    host.style.setProperty('--popup-border', toRgb(border, darkPage ? 0.48 : 0.38));
    host.style.setProperty('--popup-foreground', toRgb(foreground));
    host.style.setProperty('--popup-muted', toRgb(mutedForeground));
    host.style.setProperty('--popup-control', toRgb(controlBackground, 0.94));
    host.style.setProperty('--popup-accent', toRgb(accent));
    host.style.setProperty('--popup-accent-soft', toRgb(accentSoft));
    host.style.setProperty('--popup-font-family', fontFamily);
    host.style.setProperty('--popup-shadow', darkPage ? '0 28px 70px rgba(2, 6, 23, 0.52)' : '0 24px 60px rgba(15, 23, 42, 0.22)');
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
    const status = buildPopupStatus(host, popupTabId, popupPageUrl, textLength ?? getTextLength(host));
    const statusKey = JSON.stringify({
      exists: status.exists,
      state: status.state,
      tabId: status.tabId,
      pageUrl: status.pageUrl,
      textLength: status.textLength,
    });

    if (host.dataset.lastStatusKey === statusKey) {
      return;
    }

    host.dataset.lastStatusKey = statusKey;
    sendRuntimeMessage({
      type: 'popup-status-update',
      status,
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
    host.style.width = `${defaultWidthPx}px`;
    host.style.height = `${defaultHeightPx}px`;
    host.style.minWidth = `${minimumWidthPx}px`;
    host.style.minHeight = `${minimumHeightPx}px`;
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

  function attachResize(handle: HTMLElement, host: HTMLElement, horizontalDirection: -1 | 1, verticalDirection: -1 | 1): void {
    handle.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      event.stopPropagation();

      const rect = host.getBoundingClientRect();
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;
      const startLeft = rect.left;
      const startTop = rect.top;
      const startWidth = rect.width;
      const startHeight = rect.height;
      const originX = event.clientX;
      const originY = event.clientY;

      host.style.left = `${startLeft}px`;
      host.style.top = `${startTop}px`;
      host.style.right = 'auto';
      host.style.bottom = 'auto';

      const move = (moveEvent: PointerEvent) => {
        const deltaX = moveEvent.clientX - originX;
        const deltaY = moveEvent.clientY - originY;

        const nextWidth = clamp(
          horizontalDirection === 1 ? startWidth + deltaX : startWidth - deltaX,
          minimumWidthPx,
          viewportWidth
        );
        const nextHeight = clamp(
          verticalDirection === 1 ? startHeight + deltaY : startHeight - deltaY,
          minimumHeightPx,
          viewportHeight
        );
        const nextLeft = horizontalDirection === -1 ? clamp(startLeft + (startWidth - nextWidth), 0, viewportWidth - nextWidth) : clamp(startLeft, 0, viewportWidth - nextWidth);
        const nextTop = verticalDirection === -1 ? clamp(startTop + (startHeight - nextHeight), 0, viewportHeight - nextHeight) : clamp(startTop, 0, viewportHeight - nextHeight);

        host.style.width = `${nextWidth}px`;
        host.style.height = `${nextHeight}px`;
        host.style.left = `${nextLeft}px`;
        host.style.top = `${nextTop}px`;
      };

      const stop = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', stop);
      };

      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', stop, { once: true });
    });
  }

  function createPopupHost(): HTMLElement {
    const host = document.createElement('div');
    host.id = popupHostId;
    host.dataset.popupState = 'open';
    host.style.position = 'fixed';
    host.style.top = '24px';
    host.style.right = '24px';
    host.style.width = `${defaultWidthPx}px`;
    host.style.height = `${defaultHeightPx}px`;
    host.style.minWidth = `${minimumWidthPx}px`;
    host.style.minHeight = `${minimumHeightPx}px`;
    host.style.zIndex = '2147483647';
    host.style.overflow = 'visible';
    host.style.boxSizing = 'border-box';
    host.style.opacity = String(defaultOpacity);
    return host;
  }

  function initializePopupDom(host: HTMLElement, shadowRoot: ShadowRoot): void {
    shadowRoot.innerHTML = `
      <style>
        :host {
          all: initial;
        }
        .shell {
          position: relative;
          width: 100%;
          height: 100%;
          display: flex;
          flex-direction: column;
          border-radius: 20px;
          overflow: hidden;
          border: 1px solid var(--popup-border);
          background: var(--popup-surface);
          color: var(--popup-foreground);
          box-shadow: var(--popup-shadow);
          backdrop-filter: blur(18px);
          font-family: var(--popup-font-family);
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
          background: linear-gradient(135deg, var(--popup-accent), var(--popup-accent-soft));
          color: #fff;
          font: inherit;
          cursor: pointer;
          font-size: 16px;
        }
        .header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 12px 14px;
          gap: 12px;
          background: var(--popup-surface-strong);
          border-bottom: 1px solid var(--popup-border);
          cursor: move;
          user-select: none;
        }
        .title {
          display: flex;
          flex-direction: column;
          gap: 3px;
          min-width: 0;
        }
        .title strong {
          font-size: 13px;
          font-weight: 700;
          letter-spacing: 0.01em;
        }
        .title span {
          font-size: 11px;
          color: var(--popup-muted);
        }
        .controls {
          display: flex;
          gap: 6px;
        }
        button.control,
        button.copy,
        button.upload,
        button.send {
          border: 1px solid transparent;
          border-radius: 10px;
          background: var(--popup-control);
          color: var(--popup-foreground);
          padding: 6px 10px;
          font: inherit;
          font-size: 11px;
          line-height: 1.2;
          cursor: pointer;
          transition: transform 120ms ease, filter 120ms ease, border-color 120ms ease;
        }
        button.send {
          background: linear-gradient(135deg, var(--popup-accent), var(--popup-accent-soft));
          color: #fff;
        }
        button.control:hover,
        button.copy:hover,
        button.upload:hover,
        button.send:hover,
        .launcher:hover {
          filter: brightness(1.04);
          transform: translateY(-1px);
        }
        button.control:focus-visible,
        button.copy:focus-visible,
        button.upload:focus-visible,
        button.send:focus-visible,
        textarea:focus-visible,
        .resize-handle:focus-visible {
          outline: 2px solid var(--popup-accent);
          outline-offset: 1px;
        }
        .body {
          flex: 1;
          min-height: 0;
          padding: 12px 14px 0;
        }
        textarea {
          width: 100%;
          height: 100%;
          min-height: 0;
          resize: none;
          border: 1px solid var(--popup-border);
          border-radius: 14px;
          background: var(--popup-editor);
          color: var(--popup-foreground);
          padding: 12px;
          box-sizing: border-box;
          font-family: Consolas, 'SFMono-Regular', 'Cascadia Code', monospace;
          font-size: 12px;
          line-height: 1.5;
          white-space: pre;
          caret-color: var(--popup-accent);
        }
        .footer {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 10px 14px 14px;
          gap: 10px;
        }
        .footer-right {
          display: flex;
          align-items: center;
          gap: 10px;
          flex-wrap: wrap;
          justify-content: flex-end;
        }
        .file-pill {
          max-width: 110px;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          font-size: 10px;
          color: var(--popup-muted);
        }
        .file-pill[data-empty="true"] {
          opacity: 0.8;
        }
        .hidden-file-input {
          display: none;
        }
        .meta {
          font-size: 11px;
          color: var(--popup-muted);
        }
        .opacity-wrap {
          display: inline-flex;
          align-items: center;
          gap: 5px;
          font-size: 10px;
          color: var(--popup-muted);
        }
        .opacity-wrap input {
          width: 72px;
        }
        .resize-handle {
          position: absolute;
          width: 14px;
          height: 14px;
          border-radius: 999px;
          background: var(--popup-control);
          border: 1px solid var(--popup-border);
          box-shadow: 0 2px 10px rgba(15, 23, 42, 0.16);
          z-index: 3;
        }
        .resize-handle.nw {
          left: -7px;
          top: -7px;
          cursor: nwse-resize;
        }
        .resize-handle.ne {
          right: -7px;
          top: -7px;
          cursor: nesw-resize;
        }
        .resize-handle.sw {
          left: -7px;
          bottom: -7px;
          cursor: nesw-resize;
        }
        .resize-handle.se {
          right: -7px;
          bottom: -7px;
          cursor: nwse-resize;
        }
        .shell.minimized .resize-handle {
          display: none;
        }
      </style>
      <div class="shell" data-role="shell">
        <button class="launcher" data-role="launcher" title="Restore popup">✦</button>
        <button class="resize-handle nw" data-role="resize-nw" title="Resize from top left"></button>
        <button class="resize-handle ne" data-role="resize-ne" title="Resize from top right"></button>
        <button class="resize-handle sw" data-role="resize-sw" title="Resize from bottom left"></button>
        <button class="resize-handle se" data-role="resize-se" title="Resize from bottom right"></button>
        <div class="header" data-role="drag-handle">
          <div class="title">
            <strong>Shared Text</strong>
            <span>Context aware, always readable</span>
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
            <input class="hidden-file-input" data-role="file-input" type="file" />
            <span class="file-pill" data-role="file-name" data-empty="true">No file selected</span>
            <label class="opacity-wrap">
              <span>Opacity</span>
              <input data-role="opacity" type="range" min="0.35" max="1" step="0.05" value="0.5" />
            </label>
            <button class="copy" data-role="copy">Copy</button>
            <button class="upload" data-role="upload" title="Select a file to send to the desktop control center">⤴</button>
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
    const uploadButton = shadowRoot.querySelector<HTMLButtonElement>('[data-role="upload"]');
    const sendButton = shadowRoot.querySelector<HTMLButtonElement>('[data-role="send"]');
    const opacityInput = shadowRoot.querySelector<HTMLInputElement>('[data-role="opacity"]');
    const fileInput = shadowRoot.querySelector<HTMLInputElement>('[data-role="file-input"]');
    const fileNameLabel = shadowRoot.querySelector<HTMLElement>('[data-role="file-name"]');
    const textArea = shadowRoot.querySelector<HTMLTextAreaElement>('[data-role="content"]');
    const meta = shadowRoot.querySelector<HTMLElement>('[data-role="meta"]');
    const resizeNorthWest = shadowRoot.querySelector<HTMLButtonElement>('[data-role="resize-nw"]');
    const resizeNorthEast = shadowRoot.querySelector<HTMLButtonElement>('[data-role="resize-ne"]');
    const resizeSouthWest = shadowRoot.querySelector<HTMLButtonElement>('[data-role="resize-sw"]');
    const resizeSouthEast = shadowRoot.querySelector<HTMLButtonElement>('[data-role="resize-se"]');
    let pendingStatusTimer: number | null = null;

    if (!shell || !dragHandle || !minimizeButton || !closeButton || !launcher || !copyButton || !uploadButton || !sendButton || !opacityInput || !fileInput || !fileNameLabel || !textArea || !meta || !resizeNorthWest || !resizeNorthEast || !resizeSouthWest || !resizeSouthEast) {
      throw new Error('Popup controls could not be initialized.');
    }

    applyTheme(host);
    attachDrag(dragHandle, host);
    attachDrag(launcher, host, true);
    attachResize(resizeNorthWest, host, -1, -1);
    attachResize(resizeNorthEast, host, 1, -1);
    attachResize(resizeSouthWest, host, -1, 1);
    attachResize(resizeSouthEast, host, 1, 1);

    const scheduleStatusPublish = (nextTextLength?: number) => {
      if (pendingStatusTimer !== null) {
        window.clearTimeout(pendingStatusTimer);
      }

      pendingStatusTimer = window.setTimeout(() => {
        pendingStatusTimer = null;
        sendPopupStatus(host, tabId, location.href, nextTextLength);
      }, 120);
    };

    updateSelectedFileLabel(fileNameLabel, null);

    minimizeButton.addEventListener('click', () => {
      host.style.width = `${minimizedSizePx}px`;
      host.style.height = `${minimizedSizePx}px`;
      host.style.minWidth = `${minimizedSizePx}px`;
      host.style.minHeight = `${minimizedSizePx}px`;
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

    uploadButton.addEventListener('click', () => {
      fileInput.click();
    });

    fileInput.addEventListener('change', () => {
      updateSelectedFileLabel(fileNameLabel, fileInput.files?.[0] ?? null);
    });

    sendButton.addEventListener('click', async () => {
      const originalLabel = sendButton.textContent ?? 'Send';
      sendButton.disabled = true;

      try {
        const pendingOperations: Array<Promise<unknown>> = [];
        const selectedFile = fileInput.files?.[0] ?? null;

        if (selectedFile) {
          pendingOperations.push(
            (async () => {
              const fileBuffer = await selectedFile.arrayBuffer();
              await chrome.runtime.sendMessage({
                type: 'popup-file-send',
                payload: {
                  uploadId: crypto.randomUUID(),
                  fileName: selectedFile.name,
                  mimeType: selectedFile.type || 'application/octet-stream',
                  byteCount: selectedFile.size,
                  fileBytes: fileBuffer,
                  pageUrl: location.href,
                }
              });
            })()
          );
        }

        if (textArea.value.length > 0 || !selectedFile) {
          pendingOperations.push(
            chrome.runtime.sendMessage({
              type: 'popup-message-send',
              payload: {
                text: textArea.value,
                pageUrl: location.href,
              }
            })
          );
        }

        await Promise.all(pendingOperations);
        sendButton.textContent = 'Sent';
        fileInput.value = '';
        updateSelectedFileLabel(fileNameLabel, null);
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
      scheduleStatusPublish(textArea.value.length);
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

  applyTheme(host);

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