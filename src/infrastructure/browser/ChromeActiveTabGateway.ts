import type { BrowserTab } from '../../domain/models/BrowserTab';
import type { ActiveTabGateway } from '../../domain/ports/ActiveTabGateway';
import { BLOCKED_PROTOCOL_PREFIXES } from '../../shared/constants';

export class ChromeActiveTabGateway implements ActiveTabGateway {
  async getActiveCapturableTab(): Promise<BrowserTab | null> {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });

    if (!tab?.id || !tab.url || this.isBlockedUrl(tab.url)) {
      return null;
    }

    return {
      id: tab.id,
      title: tab.title ?? 'Untitled page',
      url: tab.url
    };
  }

  private isBlockedUrl(url: string): boolean {
    return BLOCKED_PROTOCOL_PREFIXES.some((prefix) => url.startsWith(prefix));
  }
}
