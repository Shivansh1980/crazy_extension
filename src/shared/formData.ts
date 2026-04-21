import type { CapturedPage } from '../domain/models/CapturedPage';

export function buildPostableFormData(imageFile: File, capturedPage: CapturedPage, fieldName: string): FormData {
  const formData = new FormData();
  formData.set(fieldName, imageFile, imageFile.name);
  formData.set('capturedAt', capturedPage.capturedAt);
  formData.set('pageUrl', capturedPage.tab.url);
  formData.set('pageTitle', capturedPage.tab.title);
  formData.set('widthCssPx', String(capturedPage.widthCssPx));
  formData.set('heightCssPx', String(capturedPage.heightCssPx));
  formData.set('captureScale', String(capturedPage.scale));
  return formData;
}
