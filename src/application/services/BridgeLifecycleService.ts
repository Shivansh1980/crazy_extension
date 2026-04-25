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
    // Idempotent: only opens a new socket if the existing one is closed. Does NOT force a
    // tear-down of a healthy connection, so it is safe to call from hot paths like popup
    // file send / popup message send without dropping in-flight frames.
    await this.bridgeRuntime.ensureConnected();
  }

  async forceReconnect(): Promise<void> {
    const settings = await this.settingsRepository.get();

    if (!settings.enabled) {
      return;
    }

    await this.bridgeRuntime.ensureStarted();
    await this.bridgeRuntime.reconnect();
  }
}
