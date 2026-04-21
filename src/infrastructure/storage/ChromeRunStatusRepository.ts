import type { CaptureRunStatus } from '../../domain/models/CaptureRunStatus';
import type { RunStatusRepository } from '../../domain/ports/RunStatusRepository';
import { DEFAULT_STATUS, STATUS_STORAGE_KEY } from '../../shared/constants';

export class ChromeRunStatusRepository implements RunStatusRepository {
  async get(): Promise<CaptureRunStatus> {
    const storageResult = await chrome.storage.local.get(STATUS_STORAGE_KEY);
    return { ...DEFAULT_STATUS, ...(storageResult[STATUS_STORAGE_KEY] as Partial<CaptureRunStatus> | undefined) };
  }

  async save(status: CaptureRunStatus): Promise<void> {
    await chrome.storage.local.set({ [STATUS_STORAGE_KEY]: status });
  }
}
