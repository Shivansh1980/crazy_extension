import type { BrowserTab } from './BrowserTab';

export interface CapturedPage {
  tab: BrowserTab;
  base64Data: string;
  mimeType: 'image/png';
  fileName: string;
  capturedAt: string;
  widthCssPx: number;
  heightCssPx: number;
  scale: number;
}
