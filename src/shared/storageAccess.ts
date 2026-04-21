type StorageAreaName = 'local' | 'sync';

type StorageGetResponse = {
  ok: boolean;
  value?: unknown;
  message?: string;
};

type StorageSetResponse = {
  ok: boolean;
  message?: string;
};

export async function getStorageValue<T>(area: StorageAreaName, key: string, fallback: T): Promise<T> {
  const nativeStorageArea = chrome.storage?.[area];

  if (nativeStorageArea?.get) {
    const storageResult = await nativeStorageArea.get(key);
    return (storageResult[key] as T | undefined) ?? fallback;
  }

  const response = (await sendRuntimeMessage({ type: 'storage-get', area, key })) as StorageGetResponse;
  if (!response?.ok) {
    throw new Error(response?.message || `Unable to read ${area} storage for ${key}.`);
  }

  return (response.value as T | undefined) ?? fallback;
}

export async function setStorageValue(area: StorageAreaName, key: string, value: unknown): Promise<void> {
  const nativeStorageArea = chrome.storage?.[area];

  if (nativeStorageArea?.set) {
    await nativeStorageArea.set({ [key]: value });
    return;
  }

  const response = (await sendRuntimeMessage({ type: 'storage-set', area, key, value })) as StorageSetResponse;
  if (!response?.ok) {
    throw new Error(response?.message || `Unable to write ${area} storage for ${key}.`);
  }
}

async function sendRuntimeMessage(message: object): Promise<unknown> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      const runtimeError = chrome.runtime.lastError;
      if (runtimeError) {
        reject(new Error(runtimeError.message));
        return;
      }

      resolve(response);
    });
  });
}