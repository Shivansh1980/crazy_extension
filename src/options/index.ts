import type { CaptureRunStatus } from '../domain/models/CaptureRunStatus';
import type { ExtensionSettings } from '../domain/models/ExtensionSettings';
import { ChromeRunStatusRepository } from '../infrastructure/storage/ChromeRunStatusRepository';
import { ChromeSettingsRepository } from '../infrastructure/storage/ChromeSettingsRepository';
import { DEFAULT_WEBSOCKET_RESOLVER_URL } from '../shared/constants';

const settingsRepository = new ChromeSettingsRepository();
const runStatusRepository = new ChromeRunStatusRepository();

const form = document.querySelector<HTMLFormElement>('#settings-form');
const enabledInput = document.querySelector<HTMLInputElement>('#enabled');
const websocketUrlInput = document.querySelector<HTMLInputElement>('#websocket-url');
const websocketResolverUrlInput = document.querySelector<HTMLInputElement>('#websocket-resolver-url');
const fileNamePrefixInput = document.querySelector<HTMLInputElement>('#file-name-prefix');
const requestTimeoutInput = document.querySelector<HTMLInputElement>('#request-timeout-ms');
const saveButton = document.querySelector<HTMLButtonElement>('#save-button');
const captureButton = document.querySelector<HTMLButtonElement>('#capture-button');
const reconnectButton = document.querySelector<HTMLButtonElement>('#reconnect-button');

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
  websocketResolverUrlInput.value = DEFAULT_WEBSOCKET_RESOLVER_URL;
  fileNamePrefixInput.value = settings.fileNamePrefix;
  requestTimeoutInput.value = String(settings.requestTimeoutMs);
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

async function saveSettings(event: SubmitEvent): Promise<void> {
  event.preventDefault();

  if (!enabledInput || !websocketUrlInput || !websocketResolverUrlInput || !fileNamePrefixInput || !requestTimeoutInput || !saveButton) {
    return;
  }

  saveButton.disabled = true;

  try {
    const settings = await settingsRepository.save({
      enabled: enabledInput.checked,
      websocketUrl: websocketUrlInput.value,
      websocketResolverUrl: DEFAULT_WEBSOCKET_RESOLVER_URL,
      fileNamePrefix: fileNamePrefixInput.value,
      requestTimeoutMs: Number(requestTimeoutInput.value)
    });

    renderSettings(settings);
    await chrome.runtime.sendMessage({ type: 'ensure-bridge' });
    renderStatus(await runStatusRepository.get());
  } finally {
    saveButton.disabled = false;
  }
}

async function runCaptureNow(): Promise<void> {
  if (!captureButton) {
    return;
  }

  captureButton.disabled = true;

  try {
    await chrome.runtime.sendMessage({ type: 'capture-now' });
    renderStatus(await runStatusRepository.get());
  } finally {
    captureButton.disabled = false;
  }
}

async function reconnectBridge(): Promise<void> {
  if (!reconnectButton) {
    return;
  }

  reconnectButton.disabled = true;

  try {
    await chrome.runtime.sendMessage({ type: 'ensure-bridge' });
    renderStatus(await runStatusRepository.get());
  } finally {
    reconnectButton.disabled = false;
  }
}

form?.addEventListener('submit', (event) => {
  void saveSettings(event);
});

captureButton?.addEventListener('click', () => {
  void runCaptureNow();
});

reconnectButton?.addEventListener('click', () => {
  void reconnectBridge();
});

chrome.storage?.onChanged?.addListener((changes, areaName) => {
  if (areaName === 'local' && changes['pageSignalCapture.status']) {
    void runStatusRepository.get().then(renderStatus);
  }
});

void initialize();
