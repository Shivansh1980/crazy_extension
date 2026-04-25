export interface BridgeRuntime {
  ensureStarted(): Promise<void>;
  ensureConnected(): Promise<void>;
  reconnect(): Promise<void>;
}
