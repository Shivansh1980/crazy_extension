import { getBrowserCapabilities } from '../../shared/browserCapabilities';
import { ExtensionError } from '../../shared/errors';

export class ChromeDebuggerClient {
  async attach(debuggee: chrome.debugger.Debuggee): Promise<void> {
    this.ensureDebuggerSupport();
    await this.promisify<void>((callback) => chrome.debugger.attach(debuggee, '1.3', callback));
  }

  async detach(debuggee: chrome.debugger.Debuggee): Promise<void> {
    try {
      await this.promisify<void>((callback) => chrome.debugger.detach(debuggee, callback));
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      if (!message.includes('Detached while handling command')) {
        throw error;
      }
    }
  }

  async sendCommand<TResponse>(
    debuggee: chrome.debugger.Debuggee,
    method: string,
    commandParams?: Record<string, unknown>
  ): Promise<TResponse> {
    this.ensureDebuggerSupport();
    return new Promise<TResponse>((resolve, reject) => {
      chrome.debugger.sendCommand(debuggee, method, commandParams, (result) => {
        const runtimeError = chrome.runtime.lastError;
        if (runtimeError) {
          reject(new ExtensionError(runtimeError.message ?? 'Unknown Chrome runtime error.'));
          return;
        }

        resolve(result as TResponse);
      });
    });
  }

  private ensureDebuggerSupport(): void {
    const capabilities = getBrowserCapabilities();
    if (!capabilities.debuggerApi) {
      throw new ExtensionError('This browser does not support the debugger API required for full-page capture.');
    }
  }

  private promisify<T>(executor: (callback: (value?: T) => void) => void): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      executor((value) => {
        const runtimeError = chrome.runtime.lastError;
        if (runtimeError) {
          reject(new ExtensionError(runtimeError.message ?? 'Unknown Chrome runtime error.'));
          return;
        }

        resolve(value as T);
      });
    });
  }
}
