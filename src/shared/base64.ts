export function base64ToFile(base64Data: string, fileName: string, mimeType: string): File {
  const binaryString = atob(base64Data);
  const bytes = new Uint8Array(binaryString.length);

  for (let index = 0; index < binaryString.length; index += 1) {
    bytes[index] = binaryString.charCodeAt(index);
  }

  return new File([bytes], fileName, { type: mimeType });
}
