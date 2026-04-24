export interface BrowserCapabilities {
  runtimeMessaging: boolean;
  offscreenDocument: boolean;
  debuggerApi: boolean;
  scriptingApi: boolean;
  tabsApi: boolean;
  commandsApi: boolean;
  clipboardWrite: boolean;
}

export interface BrowserIdentity {
  name: string;
  engine: 'chromium' | 'unknown';
}

export function getBrowserCapabilities(): BrowserCapabilities {
  const chromeApi = globalThis.chrome as typeof chrome | undefined;

  return {
    runtimeMessaging: Boolean(chromeApi?.runtime?.sendMessage),
    offscreenDocument: Boolean(chromeApi?.offscreen?.createDocument),
    debuggerApi: Boolean(chromeApi?.debugger?.attach && chromeApi?.debugger?.sendCommand),
    scriptingApi: Boolean(chromeApi?.scripting?.executeScript),
    tabsApi: Boolean(chromeApi?.tabs?.query),
    commandsApi: Boolean(chromeApi?.commands?.onCommand),
    clipboardWrite: Boolean(
      (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) ||
        navigator.clipboard?.writeText
    ),
  };
}

export function getBrowserIdentity(): BrowserIdentity {
  const userAgent = navigator.userAgent;

  if (/Brave\//i.test(userAgent)) {
    return { name: 'Brave', engine: 'chromium' };
  }

  if (/Edg\//i.test(userAgent)) {
    return { name: 'Microsoft Edge', engine: 'chromium' };
  }

  if (/Chrome\//i.test(userAgent)) {
    return { name: 'Google Chrome', engine: 'chromium' };
  }

  return {
    name: 'This browser',
    engine: 'unknown',
  };
}

export function getUnsupportedCapabilitiesSummary(): string[] {
  const capabilities = getBrowserCapabilities();
  const unsupported: string[] = [];

  if (!capabilities.runtimeMessaging) {
    unsupported.push('runtime messaging');
  }

  if (!capabilities.offscreenDocument) {
    unsupported.push('offscreen documents');
  }

  if (!capabilities.debuggerApi) {
    unsupported.push('debugger API');
  }

  if (!capabilities.scriptingApi) {
    unsupported.push('scripting API');
  }

  if (!capabilities.tabsApi) {
    unsupported.push('tabs API');
  }

  return unsupported;
}