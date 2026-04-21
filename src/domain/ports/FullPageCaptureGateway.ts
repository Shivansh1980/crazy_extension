import type { BrowserTab } from '../models/BrowserTab';
import type { CapturedPage } from '../models/CapturedPage';
import type { ExtensionSettings } from '../models/ExtensionSettings';

export interface FullPageCaptureGateway {
  capture(tab: BrowserTab, settings: ExtensionSettings): Promise<CapturedPage>;
}
