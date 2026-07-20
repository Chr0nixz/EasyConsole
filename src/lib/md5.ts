function rotateLeft(value: number, shift: number) {
  return (value << shift) | (value >>> (32 - shift));
}

function addUnsigned(left: number, right: number) {
  return (left + right) >>> 0;
}

function cmn(q: number, a: number, b: number, x: number, s: number, t: number) {
  return addUnsigned(rotateLeft(addUnsigned(addUnsigned(a, q), addUnsigned(x, t)), s), b);
}

function ff(a: number, b: number, c: number, d: number, x: number, s: number, t: number) {
  return cmn((b & c) | (~b & d), a, b, x, s, t);
}

function gg(a: number, b: number, c: number, d: number, x: number, s: number, t: number) {
  return cmn((b & d) | (c & ~d), a, b, x, s, t);
}

function hh(a: number, b: number, c: number, d: number, x: number, s: number, t: number) {
  return cmn(b ^ c ^ d, a, b, x, s, t);
}

function ii(a: number, b: number, c: number, d: number, x: number, s: number, t: number) {
  return cmn(c ^ (b | ~d), a, b, x, s, t);
}

function wordToHex(value: number) {
  let output = "";
  for (let index = 0; index < 4; index += 1) {
    output += `0${((value >>> (index * 8)) & 0xff).toString(16)}`.slice(-2);
  }
  return output;
}

function processBlock(state: { a: number; b: number; c: number; d: number }, block: number[]) {
  let { a, b, c, d } = state;

  a = ff(a, b, c, d, block[0], 7, 0xd76aa478);
  d = ff(d, a, b, c, block[1], 12, 0xe8c7b756);
  c = ff(c, d, a, b, block[2], 17, 0x242070db);
  b = ff(b, c, d, a, block[3], 22, 0xc1bdceee);
  a = ff(a, b, c, d, block[4], 7, 0xf57c0faf);
  d = ff(d, a, b, c, block[5], 12, 0x4787c62a);
  c = ff(c, d, a, b, block[6], 17, 0xa8304613);
  b = ff(b, c, d, a, block[7], 22, 0xfd469501);
  a = ff(a, b, c, d, block[8], 7, 0x698098d8);
  d = ff(d, a, b, c, block[9], 12, 0x8b44f7af);
  c = ff(c, d, a, b, block[10], 17, 0xffff5bb1);
  b = ff(b, c, d, a, block[11], 22, 0x895cd7be);
  a = ff(a, b, c, d, block[12], 7, 0x6b901122);
  d = ff(d, a, b, c, block[13], 12, 0xfd987193);
  c = ff(c, d, a, b, block[14], 17, 0xa679438e);
  b = ff(b, c, d, a, block[15], 22, 0x49b40821);

  a = gg(a, b, c, d, block[1], 5, 0xf61e2562);
  d = gg(d, a, b, c, block[6], 9, 0xc040b340);
  c = gg(c, d, a, b, block[11], 14, 0x265e5a51);
  b = gg(b, c, d, a, block[0], 20, 0xe9b6c7aa);
  a = gg(a, b, c, d, block[5], 5, 0xd62f105d);
  d = gg(d, a, b, c, block[10], 9, 0x02441453);
  c = gg(c, d, a, b, block[15], 14, 0xd8a1e681);
  b = gg(b, c, d, a, block[4], 20, 0xe7d3fbc8);
  a = gg(a, b, c, d, block[9], 5, 0x21e1cde6);
  d = gg(d, a, b, c, block[14], 9, 0xc33707d6);
  c = gg(c, d, a, b, block[3], 14, 0xf4d50d87);
  b = gg(b, c, d, a, block[8], 20, 0x455a14ed);
  a = gg(a, b, c, d, block[13], 5, 0xa9e3e905);
  d = gg(d, a, b, c, block[2], 9, 0xfcefa3f8);
  c = gg(c, d, a, b, block[7], 14, 0x676f02d9);
  b = gg(b, c, d, a, block[12], 20, 0x8d2a4c8a);

  a = hh(a, b, c, d, block[5], 4, 0xfffa3942);
  d = hh(d, a, b, c, block[8], 11, 0x8771f681);
  c = hh(c, d, a, b, block[11], 16, 0x6d9d6122);
  b = hh(b, c, d, a, block[14], 23, 0xfde5380c);
  a = hh(a, b, c, d, block[1], 4, 0xa4beea44);
  d = hh(d, a, b, c, block[4], 11, 0x4bdecfa9);
  c = hh(c, d, a, b, block[7], 16, 0xf6bb4b60);
  b = hh(b, c, d, a, block[10], 23, 0xbebfbc70);
  a = hh(a, b, c, d, block[13], 4, 0x289b7ec6);
  d = hh(d, a, b, c, block[0], 11, 0xeaa127fa);
  c = hh(c, d, a, b, block[3], 16, 0xd4ef3085);
  b = hh(b, c, d, a, block[6], 23, 0x04881d05);
  a = hh(a, b, c, d, block[9], 4, 0xd9d4d039);
  d = hh(d, a, b, c, block[12], 11, 0xe6db99e5);
  c = hh(c, d, a, b, block[15], 16, 0x1fa27cf8);
  b = hh(b, c, d, a, block[2], 23, 0xc4ac5665);

  a = ii(a, b, c, d, block[0], 6, 0xf4292244);
  d = ii(d, a, b, c, block[7], 10, 0x432aff97);
  c = ii(c, d, a, b, block[14], 15, 0xab9423a7);
  b = ii(b, c, d, a, block[5], 21, 0xfc93a039);
  a = ii(a, b, c, d, block[12], 6, 0x655b59c3);
  d = ii(d, a, b, c, block[3], 10, 0x8f0ccc92);
  c = ii(c, d, a, b, block[10], 15, 0xffeff47d);
  b = ii(b, c, d, a, block[1], 21, 0x85845dd1);
  a = ii(a, b, c, d, block[8], 6, 0x6fa87e4f);
  d = ii(d, a, b, c, block[15], 10, 0xfe2ce6e0);
  c = ii(c, d, a, b, block[6], 15, 0xa3014314);
  b = ii(b, c, d, a, block[13], 21, 0x4e0811a1);
  a = ii(a, b, c, d, block[4], 6, 0xf7537e82);
  d = ii(d, a, b, c, block[11], 10, 0xbd3af235);
  c = ii(c, d, a, b, block[2], 15, 0x2ad7d2bb);
  b = ii(b, c, d, a, block[9], 21, 0xeb86d391);

  state.a = addUnsigned(state.a, a);
  state.b = addUnsigned(state.b, b);
  state.c = addUnsigned(state.c, c);
  state.d = addUnsigned(state.d, d);
}

function bytesToBlock(bytes: Uint8Array, offset: number) {
  const block = new Array<number>(16).fill(0);
  for (let index = 0; index < 64; index += 1) {
    block[index >> 2] |= bytes[offset + index] << ((index % 4) * 8);
  }
  return block;
}

export type Md5Hasher = {
  update(chunk: ArrayBuffer | Uint8Array): void;
  digest(): string;
};

/** Incremental MD5 hasher so large blobs can be processed in chunks. */
export function createMd5Hasher(): Md5Hasher {
  const state = {
    a: 0x67452301,
    b: 0xefcdab89,
    c: 0x98badcfe,
    d: 0x10325476,
  };
  let totalLength = 0;
  let remainder = new Uint8Array(0);
  let finalized = false;

  return {
    update(chunk) {
      if (finalized) throw new Error("MD5 hasher already finalized");
      const input = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
      totalLength += input.length;
      const merged = new Uint8Array(remainder.length + input.length);
      merged.set(remainder, 0);
      merged.set(input, remainder.length);

      let offset = 0;
      while (offset + 64 <= merged.length) {
        processBlock(state, bytesToBlock(merged, offset));
        offset += 64;
      }
      remainder = merged.slice(offset);
    },
    digest() {
      if (finalized) throw new Error("MD5 hasher already finalized");
      finalized = true;
      const bitLength = totalLength * 8;
      const paddingLength = (remainder.length < 56 ? 56 : 120) - remainder.length;
      const finalBlock = new Uint8Array(remainder.length + paddingLength + 8);
      finalBlock.set(remainder, 0);
      finalBlock[remainder.length] = 0x80;
      const view = new DataView(finalBlock.buffer, finalBlock.byteOffset, finalBlock.byteLength);
      view.setUint32(finalBlock.length - 8, bitLength >>> 0, true);
      view.setUint32(finalBlock.length - 4, Math.floor(bitLength / 0x100000000), true);

      for (let offset = 0; offset < finalBlock.length; offset += 64) {
        processBlock(state, bytesToBlock(finalBlock, offset));
      }

      return `${wordToHex(state.a)}${wordToHex(state.b)}${wordToHex(state.c)}${wordToHex(state.d)}`;
    },
  };
}

export function md5ArrayBuffer(buffer: ArrayBuffer) {
  const hasher = createMd5Hasher();
  hasher.update(buffer);
  return hasher.digest();
}

export const MD5_BLOB_CHUNK_SIZE = 2 * 1024 * 1024;

async function md5BlobOnMain(blob: Blob, chunkSize: number) {
  const hasher = createMd5Hasher();
  let offset = 0;
  while (offset < blob.size) {
    const end = Math.min(offset + chunkSize, blob.size);
    const chunk = await blob.slice(offset, end).arrayBuffer();
    hasher.update(chunk);
    offset = end;
    if (offset < blob.size) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  }
  return hasher.digest();
}

async function md5BlobWithWorker(blob: Blob, chunkSize: number) {
  const Md5Worker = (await import("./md5.worker.ts?worker")).default;
  const worker = new Md5Worker();

  return new Promise<string>((resolve, reject) => {
    worker.onmessage = (event: MessageEvent<string>) => {
      resolve(event.data);
      worker.terminate();
    };
    worker.onerror = (event: ErrorEvent) => {
      reject(event.error ?? new Error("MD5 worker failed"));
      worker.terminate();
    };

    void (async () => {
      try {
        worker.postMessage({ type: "reset" });
        let offset = 0;
        while (offset < blob.size) {
          const end = Math.min(offset + chunkSize, blob.size);
          const chunk = await blob.slice(offset, end).arrayBuffer();
          offset = end;
          const done = offset >= blob.size;
          worker.postMessage({ type: "chunk", buffer: chunk, done }, [chunk]);
        }
        if (blob.size === 0) {
          worker.postMessage({ type: "finalize" });
        }
      } catch (error) {
        worker.terminate();
        reject(error);
      }
    })();
  });
}

export async function md5Blob(blob: Blob, chunkSize = MD5_BLOB_CHUNK_SIZE) {
  // Prefer Worker so large uploads do not block the UI; fall back to main-thread chunking
  // when Workers are unavailable (Node CLI/MCP, SSR) or worker creation fails.
  if (typeof Worker !== "undefined") {
    try {
      return await md5BlobWithWorker(blob, chunkSize);
    } catch {
      // fall through
    }
  }
  return md5BlobOnMain(blob, chunkSize);
}
