import type { BrowserTab } from '../models/BrowserTab';

export interface ActiveTabGateway {
  getActiveCapturableTab(): Promise<BrowserTab | null>;
}
