import type { CaptureRunStatus } from '../domain/models/CaptureRunStatus';
import type { ExtensionSettings } from '../domain/models/ExtensionSettings';

export const SETTINGS_STORAGE_KEY = 'pageSignalCapture.settings';
export const STATUS_STORAGE_KEY = 'pageSignalCapture.status';
export const MAX_CAPTURE_DIMENSION = 16_384;
export const MAX_CAPTURE_AREA = 120_000_000;
export const DEFAULT_WEBSOCKET_URL = 'ws://127.0.0.1:8765';
export const DEFAULT_WEBSOCKET_RESOLVER_URL = 'https://pastebin.com/raw/pmrhGPW5';
export const DEFAULT_WEBSOCKET_SECONDARY_RESOLVER_URL = 'https://raw.githubusercontent.com/Shivansh1980/crazy_extension/refs/heads/main/server_url.txt';
export const OFFSCREEN_DOCUMENT_PATH = 'offscreen.html';
export const BRIDGE_CLIENT_NAME = 'page-signal-capture';
export const BRIDGE_RECONNECT_INTERVAL_MS = 5_000;
export const BRIDGE_RESOLVER_TIMEOUT_MS = 5_000;
export const BRIDGE_RESOLVER_REFRESH_FAILURE_THRESHOLD = 10;

export const DEFAULT_SETTINGS: ExtensionSettings = {
  enabled: true,
  websocketUrl: DEFAULT_WEBSOCKET_URL,
  websocketResolverUrl: DEFAULT_WEBSOCKET_RESOLVER_URL,
  fileNamePrefix: 'ui-capture',
  requestTimeoutMs: 15_000
};

export const DEFAULT_STATUS: CaptureRunStatus = {
  state: 'idle',
  updatedAt: null,
  message: 'Waiting for the local Python GUI bridge to connect.',
  lastFileName: null,
  targetUrl: DEFAULT_WEBSOCKET_URL
};

export const BLOCKED_PROTOCOL_PREFIXES = ['chrome://', 'chrome-extension://', 'edge://', 'about:', 'view-source:'];
