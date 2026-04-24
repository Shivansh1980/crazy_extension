import type { BrowserTab } from '../../domain/models/BrowserTab';
import type { CapturedPage } from '../../domain/models/CapturedPage';
import type { ExtensionSettings } from '../../domain/models/ExtensionSettings';
import type { FullPageCaptureGateway } from '../../domain/ports/FullPageCaptureGateway';
import { ExtensionError } from '../../shared/errors';

export class UnsupportedFullPageCaptureGateway implements FullPageCaptureGateway {
  constructor(private readonly reason: string) {}

  async capture(_tab: BrowserTab, _settings: ExtensionSettings): Promise<CapturedPage> {
    throw new ExtensionError(this.reason);
  }
}