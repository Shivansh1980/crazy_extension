import { ExtensionError } from '../../shared/errors';

export type ScreenShareState = 'idle' | 'launching' | 'active' | 'ended' | 'error';

export interface ScreenShareStatus {
  state: ScreenShareState;
  active: boolean;
  viewerWindowId: number | null;
  sourceLabel: string | null;
  updatedAt: string;
  message: string;
}

export class ChromeScreenShareGateway {
  private viewerWindowId: number | null = null;
  private latestStatus: ScreenShareStatus = {
    state: 'idle',
    active: false,
    viewerWindowId: null,
    sourceLabel: null,
    updatedAt: new Date().toISOString(),
    message: 'Screen share is idle.',
  };

  async start(): Promise<ScreenShareStatus> {
    this.ensureSupport();

    if (this.viewerWindowId !== null && (this.latestStatus.active || this.latestStatus.state === 'launching')) {
      await this.focusViewerWindow();
      return this.latestStatus;
    }

    const createdWindow = await chrome.windows.create({
      url: chrome.runtime.getURL('screen-share.html'),
      type: 'popup',
      focused: true,
      state: 'maximized',
    });
    if (!createdWindow) {
      throw new ExtensionError('Chrome did not return a screen share popup window.');
    }

    this.viewerWindowId = typeof createdWindow.id === 'number' ? createdWindow.id : null;
    this.latestStatus = {
      state: 'launching',
      active: false,
      viewerWindowId: this.viewerWindowId,
      sourceLabel: null,
      updatedAt: new Date().toISOString(),
      message: 'Browser sharing window opened. Click Start Streaming in Chrome to open the picker.',
    };
    return this.latestStatus;
  }

  updateStatus(status: Omit<ScreenShareStatus, 'viewerWindowId'> & { viewerWindowId?: number | null }): ScreenShareStatus {
    this.latestStatus = {
      ...status,
      viewerWindowId: status.viewerWindowId ?? this.viewerWindowId,
    };
    this.viewerWindowId = this.latestStatus.viewerWindowId;
    return this.latestStatus;
  }

  handleViewerWindowRemoved(windowId: number): ScreenShareStatus | null {
    if (windowId !== this.viewerWindowId) {
      return null;
    }

    this.viewerWindowId = null;
    this.latestStatus = {
      state: 'ended',
      active: false,
      viewerWindowId: null,
      sourceLabel: null,
      updatedAt: new Date().toISOString(),
      message: 'Screen share window closed.',
    };
    return this.latestStatus;
  }

  getStatus(): ScreenShareStatus {
    return this.latestStatus;
  }

  private async focusViewerWindow(): Promise<void> {
    if (this.viewerWindowId === null) {
      return;
    }

    try {
      await chrome.windows.update(this.viewerWindowId, { focused: true });
    } catch {
      this.viewerWindowId = null;
    }
  }

  private ensureSupport(): void {
    if (!chrome.windows?.create) {
      throw new ExtensionError('This browser does not support extension popup windows required for screen share preview.');
    }
  }
}
