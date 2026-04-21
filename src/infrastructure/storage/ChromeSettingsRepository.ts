import type { ExtensionSettings } from '../../domain/models/ExtensionSettings';
import type { SettingsRepository } from '../../domain/ports/SettingsRepository';
import { normalizeResolverUrl, normalizeWebSocketUrl } from '../../shared/bridgeUrlResolver';
import { DEFAULT_SETTINGS, DEFAULT_WEBSOCKET_RESOLVER_URL, SETTINGS_STORAGE_KEY } from '../../shared/constants';
import { getStorageValue, setStorageValue } from '../../shared/storageAccess';

export class ChromeSettingsRepository implements SettingsRepository {
  async get(): Promise<ExtensionSettings> {
    const storedValue = await getStorageValue<Partial<ExtensionSettings> | undefined>('sync', SETTINGS_STORAGE_KEY, undefined);
    return this.normalize({ ...DEFAULT_SETTINGS, ...(storedValue ?? {}) });
  }

  async save(patch: Partial<ExtensionSettings>): Promise<ExtensionSettings> {
    const nextValue = this.normalize({ ...(await this.get()), ...patch });
    await setStorageValue('sync', SETTINGS_STORAGE_KEY, nextValue);
    return nextValue;
  }

  private normalize(settings: ExtensionSettings): ExtensionSettings {
    return {
      enabled: Boolean(settings.enabled),
      websocketUrl: normalizeWebSocketUrl(settings.websocketUrl),
      websocketResolverUrl: normalizeResolverUrl(DEFAULT_WEBSOCKET_RESOLVER_URL),
      fileNamePrefix: settings.fileNamePrefix.trim() || DEFAULT_SETTINGS.fileNamePrefix,
      requestTimeoutMs: Math.max(1_000, Math.round(settings.requestTimeoutMs || DEFAULT_SETTINGS.requestTimeoutMs))
    };
  }
}
