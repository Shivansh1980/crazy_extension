import type { CaptureRunStatus } from '../../domain/models/CaptureRunStatus';
import type { RunStatusRepository } from '../../domain/ports/RunStatusRepository';
import { DEFAULT_STATUS, STATUS_STORAGE_KEY } from '../../shared/constants';
import { getStorageValue, setStorageValue } from '../../shared/storageAccess';

export class ChromeRunStatusRepository implements RunStatusRepository {
  async get(): Promise<CaptureRunStatus> {
    const storedValue = await getStorageValue<Partial<CaptureRunStatus> | undefined>('local', STATUS_STORAGE_KEY, undefined);
    return { ...DEFAULT_STATUS, ...(storedValue ?? {}) };
  }

  async save(status: CaptureRunStatus): Promise<void> {
    await setStorageValue('local', STATUS_STORAGE_KEY, status);
  }
}
