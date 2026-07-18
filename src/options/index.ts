import type { CaptureRunStatus } from '../domain/models/CaptureRunStatus';
import type { ConnectionMode, ExtensionSettings } from '../domain/models/ExtensionSettings';
import { ChromeRunStatusRepository } from '../infrastructure/storage/ChromeRunStatusRepository';
import { ChromeSettingsRepository } from '../infrastructure/storage/ChromeSettingsRepository';

const settingsRepository = new ChromeSettingsRepository();
const runStatusRepository = new ChromeRunStatusRepository();

const form = document.querySelector<HTMLFormElement>('#settings-form');
const enabledInput = document.querySelector<HTMLInputElement>('#enabled');
const websocketUrlInput = document.querySelector<HTMLInputElement>('#websocket-url');
const websocketResolverUrlInput = document.querySelector<HTMLInputElement>('#websocket-resolver-url');
const fileNamePrefixInput = document.querySelector<HTMLInputElement>('#file-name-prefix');
const requestTimeoutInput = document.querySelector<HTMLInputElement>('#request-timeout-ms');
const connectionModeInput = document.querySelector<HTMLSelectElement>('#connection-mode');
const relayUrlInput = document.querySelector<HTMLInputElement>('#relay-url');
const sessionIdInput = document.querySelector<HTMLInputElement>('#session-id');
const reconnectButton = document.querySelector<HTMLButtonElement>('#reconnect-button');
const applyReconnectButton = document.querySelector<HTMLButtonElement>('#apply-reconnect-button');

const statusState = document.querySelector<HTMLElement>('#status-state');
const statusMessage = document.querySelector<HTMLElement>('#status-message');
const statusUpdatedAt = document.querySelector<HTMLElement>('#status-updated-at');
const statusFileName = document.querySelector<HTMLElement>('#status-file-name');
const statusTarget = document.querySelector<HTMLElement>('#status-target');

async function initialize(): Promise<void> {
  const [settings, status] = await Promise.all([settingsRepository.get(), runStatusRepository.get()]);
  renderSettings(settings);
  renderStatus(status);
}

function renderSettings(settings: ExtensionSettings): void {
  if (!form || !enabledInput || !websocketUrlInput || !websocketResolverUrlInput || !fileNamePrefixInput || !requestTimeoutInput) {
    return;
  }

  enabledInput.checked = settings.enabled;
  websocketUrlInput.value = settings.websocketUrl;
  websocketResolverUrlInput.value = settings.websocketResolverUrl;
  fileNamePrefixInput.value = settings.fileNamePrefix;
  requestTimeoutInput.value = String(settings.requestTimeoutMs);
  if (connectionModeInput) connectionModeInput.value = settings.connectionMode;
  if (relayUrlInput) relayUrlInput.value = settings.relayUrl;
  if (sessionIdInput) sessionIdInput.value = settings.sessionId;
}

function renderStatus(status: CaptureRunStatus): void {
  if (!statusState || !statusMessage || !statusUpdatedAt || !statusFileName || !statusTarget) {
    return;
  }

  statusState.dataset.state = status.state;
  statusState.textContent = status.state;
  statusMessage.textContent = status.message;
  statusUpdatedAt.textContent = status.updatedAt ? new Date(status.updatedAt).toLocaleString() : 'Never';
  statusFileName.textContent = status.lastFileName ?? 'Not available';
  statusTarget.textContent = status.targetUrl ?? 'Not configured';
}

function readFormPatch(): Partial<ExtensionSettings> | null {
  if (!enabledInput || !websocketUrlInput || !fileNamePrefixInput || !requestTimeoutInput) {
    return null;
  }
  return {
    enabled: enabledInput.checked,
    websocketUrl: websocketUrlInput.value,
    websocketResolverUrl: websocketResolverUrlInput?.value ?? '',
    fileNamePrefix: fileNamePrefixInput.value,
    requestTimeoutMs: Number(requestTimeoutInput.value),
    connectionMode: (connectionModeInput?.value ?? 'auto') as ConnectionMode,
    relayUrl: relayUrlInput?.value ?? '',
    sessionId: sessionIdInput?.value ?? ''
  };
}

async function applyAndReconnect(event?: SubmitEvent): Promise<void> {
  event?.preventDefault();

  const patch = readFormPatch();
  if (!patch || !applyReconnectButton) return;

  applyReconnectButton.disabled = true;
  try {
    const settings = await settingsRepository.save(patch);
    renderSettings(settings);
    // Save + force a clean reconnect using the new settings.
    const response = await chrome.runtime.sendMessage({ type: 'reconnect-bridge' });
    if (!response?.ok) {
      throw new Error(response?.message ?? 'The extension could not restart the bridge.');
    }
    renderStatus(await runStatusRepository.get());
  } catch (error) {
    renderTransientError(error);
  } finally {
    applyReconnectButton.disabled = false;
  }
}

async function reconnectBridge(): Promise<void> {
  if (!reconnectButton) {
    return;
  }

  reconnectButton.disabled = true;

  try {
    const response = await chrome.runtime.sendMessage({ type: 'reconnect-bridge' });
    if (!response?.ok) {
      throw new Error(response?.message ?? 'The extension could not reconnect the bridge.');
    }
    renderStatus(await runStatusRepository.get());
  } catch (error) {
    renderTransientError(error);
  } finally {
    reconnectButton.disabled = false;
  }
}

form?.addEventListener('submit', (event) => {
  void applyAndReconnect(event);
});

reconnectButton?.addEventListener('click', () => {
  void reconnectBridge();
});

applyReconnectButton?.addEventListener('click', (event) => {
  // Type=submit on this button means the form submit handler already runs; the click handler
  // is a no-op safety net for the case where the button is detached from the form.
  if ((event.target as HTMLButtonElement).type !== 'submit') {
    void applyAndReconnect();
  }
});

chrome.storage?.onChanged?.addListener((changes, areaName) => {
  if (areaName === 'local' && changes['pageSignalCapture.status']) {
    void runStatusRepository.get().then(renderStatus);
  }
});

function renderTransientError(error: unknown): void {
  if (statusState) {
    statusState.dataset.state = 'error';
    statusState.textContent = 'error';
  }
  if (statusMessage) {
    statusMessage.textContent = error instanceof Error ? error.message : 'The bridge operation failed.';
  }
}

void initialize().catch(renderTransientError);
