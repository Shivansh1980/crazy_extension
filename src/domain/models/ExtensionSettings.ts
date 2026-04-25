export type ConnectionMode = 'auto' | 'relay' | 'tunnel';

export interface ExtensionSettings {
  enabled: boolean;
  websocketUrl: string;
  websocketResolverUrl: string;
  fileNamePrefix: string;
  requestTimeoutMs: number;
  connectionMode: ConnectionMode;
  relayUrl: string;
  sessionId: string;
}
