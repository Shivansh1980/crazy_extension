import type { ConnectionMode, ExtensionSettings } from '../../domain/models/ExtensionSettings';
import type { SettingsRepository } from '../../domain/ports/SettingsRepository';
import { normalizeOptionalWebSocketUrl, normalizeResolverUrl, normalizeWebSocketUrl } from '../../shared/bridgeUrlResolver';
import { DEFAULT_SETTINGS, DEFAULT_WEBSOCKET_RESOLVER_URL, SETTINGS_STORAGE_KEY } from '../../shared/constants';
import { getStorageValue, setStorageValue } from '../../shared/storageAccess';

const VALID_CONNECTION_MODES: ReadonlySet<ConnectionMode> = new Set(['auto', 'relay', 'tunnel']);

function normalizeConnectionMode(value: unknown): ConnectionMode {
  return typeof value === 'string' && VALID_CONNECTION_MODES.has(value as ConnectionMode)
    ? (value as ConnectionMode)
    : DEFAULT_SETTINGS.connectionMode;
}

function normalizeRelayUrl(value: unknown): string {
  if (typeof value !== 'string') return '';
  return normalizeOptionalWebSocketUrl(value);
}

function normalizeSessionId(value: unknown): string {
  if (typeof value !== 'string') return DEFAULT_SETTINGS.sessionId;
  const trimmed = value.trim();
  return trimmed || DEFAULT_SETTINGS.sessionId;
}

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
      requestTimeoutMs: Math.max(1_000, Math.round(settings.requestTimeoutMs || DEFAULT_SETTINGS.requestTimeoutMs)),
      connectionMode: normalizeConnectionMode(settings.connectionMode),
      relayUrl: normalizeRelayUrl(settings.relayUrl),
      sessionId: normalizeSessionId(settings.sessionId)
    };
  }
}
