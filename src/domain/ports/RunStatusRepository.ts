import type { CaptureRunStatus } from '../models/CaptureRunStatus';

export interface RunStatusRepository {
  get(): Promise<CaptureRunStatus>;
  save(status: CaptureRunStatus): Promise<void>;
}
