export function buildCaptureFileName(prefix: string, capturedAt: string): string {
  const timestamp = capturedAt.replace(/[:.]/g, '-');
  return `${prefix}-${timestamp}.png`;
}
