import type { ExtensionSettings } from '../models/ExtensionSettings';

export interface SettingsRepository {
  get(): Promise<ExtensionSettings>;
  save(patch: Partial<ExtensionSettings>): Promise<ExtensionSettings>;
}
