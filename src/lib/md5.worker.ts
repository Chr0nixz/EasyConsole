/// <reference lib="webworker" />

import { md5ArrayBuffer } from "./md5";

self.onmessage = (event: MessageEvent<ArrayBuffer>) => {
  const hash = md5ArrayBuffer(event.data);
  (self as unknown as DedicatedWorkerGlobalScope).postMessage(hash);
};
