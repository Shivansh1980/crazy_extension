declare namespace chrome.offscreen {
  enum Reason {
    BLOBS = 'BLOBS'
  }

  interface CreateParameters {
    url: string;
    reasons: Reason[];
    justification: string;
  }

  function createDocument(parameters: CreateParameters): Promise<void>;
}
