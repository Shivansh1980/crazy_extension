export interface BridgeRuntime {
  ensureStarted(): Promise<void>;
  reconnect(): Promise<void>;
}
