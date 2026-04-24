declare namespace chrome.desktopCapture {
  type DesktopCaptureSourceType = 'screen' | 'window' | 'tab' | 'audio';

  interface DesktopCaptureOptions {
    canRequestAudioTrack?: boolean;
  }

  function chooseDesktopMedia(
    sources: DesktopCaptureSourceType[],
    callback: (streamId: string, options?: DesktopCaptureOptions) => void
  ): number;

  function chooseDesktopMedia(
    sources: DesktopCaptureSourceType[],
    targetTab: chrome.tabs.Tab,
    callback: (streamId: string, options?: DesktopCaptureOptions) => void
  ): number;

  function cancelChooseDesktopMedia(requestId: number): void;
}