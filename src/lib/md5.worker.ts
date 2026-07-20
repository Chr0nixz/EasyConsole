/// <reference lib="webworker" />

import { createMd5Hasher, md5ArrayBuffer } from "./md5";

type WorkerRequest =
  | { type: "reset" }
  | { type: "buffer"; buffer: ArrayBuffer }
  | { type: "chunk"; buffer: ArrayBuffer; done?: boolean }
  | { type: "finalize" };

let hasher = createMd5Hasher();

self.onmessage = (event: MessageEvent<WorkerRequest | ArrayBuffer>) => {
  const data = event.data;
  // Backward-compatible single-buffer message used by older callers.
  if (data instanceof ArrayBuffer) {
    const hash = md5ArrayBuffer(data);
    (self as unknown as DedicatedWorkerGlobalScope).postMessage(hash);
    return;
  }

  if (data.type === "reset") {
    hasher = createMd5Hasher();
    return;
  }

  if (data.type === "buffer") {
    hasher = createMd5Hasher();
    hasher.update(data.buffer);
    (self as unknown as DedicatedWorkerGlobalScope).postMessage(hasher.digest());
    hasher = createMd5Hasher();
    return;
  }

  if (data.type === "chunk") {
    hasher.update(data.buffer);
    if (data.done) {
      (self as unknown as DedicatedWorkerGlobalScope).postMessage(hasher.digest());
      hasher = createMd5Hasher();
    }
    return;
  }

  if (data.type === "finalize") {
    (self as unknown as DedicatedWorkerGlobalScope).postMessage(hasher.digest());
    hasher = createMd5Hasher();
  }
};
