const DEBUG_LOGGING_ENABLED = true;

function normalizeDetails(details: unknown): unknown {
  if (details instanceof Error) {
    return {
      name: details.name,
      message: details.message,
      stack: details.stack
    };
  }

  if (typeof details === 'object' && details !== null) {
    return JSON.parse(JSON.stringify(details, (_key, value) => {
      if (value instanceof Error) {
        return {
          name: value.name,
          message: value.message,
          stack: value.stack
        };
      }

      return value;
    }));
  }

  return details;
}

export function debugLog(scope: string, message: string, details?: unknown): void {
  if (!DEBUG_LOGGING_ENABLED) {
    return;
  }

  if (details === undefined) {
    console.log(`[${scope}] ${message}`);
    return;
  }

  console.log(`[${scope}] ${message}`, normalizeDetails(details));
}

export function debugWarn(scope: string, message: string, details?: unknown): void {
  if (!DEBUG_LOGGING_ENABLED) {
    return;
  }

  if (details === undefined) {
    console.warn(`[${scope}] ${message}`);
    return;
  }

  console.warn(`[${scope}] ${message}`, normalizeDetails(details));
}

export function debugError(scope: string, message: string, details?: unknown): void {
  if (!DEBUG_LOGGING_ENABLED) {
    return;
  }

  if (details === undefined) {
    console.error(`[${scope}] ${message}`);
    return;
  }

  console.error(`[${scope}] ${message}`, normalizeDetails(details));
}
