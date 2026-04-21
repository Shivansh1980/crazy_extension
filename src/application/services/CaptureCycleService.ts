import type { CaptureRunStatus } from '../../domain/models/CaptureRunStatus';
import type { CapturedPage } from '../../domain/models/CapturedPage';
import type { ActiveTabGateway } from '../../domain/ports/ActiveTabGateway';
import type { FullPageCaptureGateway } from '../../domain/ports/FullPageCaptureGateway';
import type { RunStatusRepository } from '../../domain/ports/RunStatusRepository';
import type { SettingsRepository } from '../../domain/ports/SettingsRepository';
import { ExtensionError } from '../../shared/errors';

export class CaptureCycleService {
  constructor(
    private readonly settingsRepository: SettingsRepository,
    private readonly activeTabGateway: ActiveTabGateway,
    private readonly fullPageCaptureGateway: FullPageCaptureGateway,
    private readonly runStatusRepository: RunStatusRepository
  ) {}

  async execute(): Promise<CapturedPage> {
    const settings = await this.settingsRepository.get();

    if (!settings.enabled) {
      const error = new ExtensionError('The extension bridge is disabled in options.');
      await this.saveStatus({
        state: 'skipped',
        updatedAt: new Date().toISOString(),
        message: error.message,
        lastFileName: null,
        targetUrl: settings.websocketUrl
      });
      throw error;
    }

    const tab = await this.activeTabGateway.getActiveCapturableTab();

    if (!tab) {
      const error = new ExtensionError('No capturable active tab is available. Bring the target page into focus and try again.');
      await this.saveStatus({
        state: 'skipped',
        updatedAt: new Date().toISOString(),
        message: error.message,
        lastFileName: null,
        targetUrl: settings.websocketUrl
      });
      throw error;
    }

    try {
      const capturedPage = await this.fullPageCaptureGateway.capture(tab, settings);
      await this.saveStatus({
        state: 'success',
        updatedAt: new Date().toISOString(),
        message: 'Screenshot captured successfully for the desktop bridge.',
        lastFileName: capturedPage.fileName,
        targetUrl: settings.websocketUrl
      });
      return capturedPage;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown capture error.';
      await this.saveStatus({
        state: 'error',
        updatedAt: new Date().toISOString(),
        message,
        lastFileName: null,
        targetUrl: settings.websocketUrl
      });
      throw error;
    }
  }

  private async saveStatus(status: CaptureRunStatus): Promise<void> {
    await this.runStatusRepository.save(status);
  }
}
