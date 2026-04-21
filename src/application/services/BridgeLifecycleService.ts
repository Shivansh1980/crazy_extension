import type { BridgeRuntime } from '../../domain/ports/BridgeRuntime';
import type { SettingsRepository } from '../../domain/ports/SettingsRepository';

export class BridgeLifecycleService {
  constructor(
    private readonly settingsRepository: SettingsRepository,
    private readonly bridgeRuntime: BridgeRuntime
  ) {}

  async ensureOnline(): Promise<void> {
    const settings = await this.settingsRepository.get();

    if (!settings.enabled) {
      return;
    }

    await this.bridgeRuntime.ensureStarted();
    await this.bridgeRuntime.reconnect();
  }
}
