import type { ExtensionSettings } from '../../domain/models/ExtensionSettings';
import type { SettingsRepository } from '../../domain/ports/SettingsRepository';
import { normalizeResolverUrl, normalizeWebSocketUrl } from '../../shared/bridgeUrlResolver';
import { DEFAULT_SETTINGS, SETTINGS_STORAGE_KEY } from '../../shared/constants';

export class ChromeSettingsRepository implements SettingsRepository {
  async get(): Promise<ExtensionSettings> {
    const storageResult = await chrome.storage.sync.get(SETTINGS_STORAGE_KEY);
    return this.normalize({ ...DEFAULT_SETTINGS, ...(storageResult[SETTINGS_STORAGE_KEY] as Partial<ExtensionSettings> | undefined) });
  }

  async save(patch: Partial<ExtensionSettings>): Promise<ExtensionSettings> {
    const nextValue = this.normalize({ ...(await this.get()), ...patch });
    await chrome.storage.sync.set({ [SETTINGS_STORAGE_KEY]: nextValue });
    return nextValue;
  }

  private normalize(settings: ExtensionSettings): ExtensionSettings {
    return {
      enabled: Boolean(settings.enabled),
      websocketUrl: normalizeWebSocketUrl(settings.websocketUrl),
      websocketResolverUrl: normalizeResolverUrl(settings.websocketResolverUrl),
      fileNamePrefix: settings.fileNamePrefix.trim() || DEFAULT_SETTINGS.fileNamePrefix,
      requestTimeoutMs: Math.max(1_000, Math.round(settings.requestTimeoutMs || DEFAULT_SETTINGS.requestTimeoutMs))
    };
  }
}
