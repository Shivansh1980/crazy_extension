import type { BridgeRuntime } from '../../domain/ports/BridgeRuntime';
import { ExtensionError } from '../../shared/errors';

export class UnsupportedBridgeRuntime implements BridgeRuntime {
  constructor(private readonly reason: string) {}

  async ensureStarted(): Promise<void> {
    throw new ExtensionError(this.reason);
  }

  async ensureConnected(): Promise<void> {
    throw new ExtensionError(this.reason);
  }

  async reconnect(): Promise<void> {
    throw new ExtensionError(this.reason);
  }
}