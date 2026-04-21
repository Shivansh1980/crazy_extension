export type CaptureState = 'idle' | 'success' | 'error' | 'skipped' | 'connecting' | 'connected' | 'disconnected';

export interface CaptureRunStatus {
  state: CaptureState;
  updatedAt: string | null;
  message: string;
  lastFileName: string | null;
  targetUrl: string | null;
}
