import { isTauri } from "@tauri-apps/api/core";
import { getRuntimeKind } from "./runtime";

const WINDOWS_RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

export function sanitizeDownloadFilename(filename: string, fallback = "easy-console-download") {
  const sanitized = filename
    .replace(/[<>:"/\\|?*]/g, "_")
    .split("")
    .map((character) => (character.charCodeAt(0) < 32 ? "_" : character))
    .join("")
    .replace(/\s+/g, " ")
    .replace(/[. ]+$/g, "")
    .trim();
  if (!sanitized || WINDOWS_RESERVED_NAMES.test(sanitized)) return fallback;
  return sanitized.slice(0, 180);
}

function saveBlobInBrowser(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = sanitizeDownloadFilename(filename);
  link.rel = "noreferrer";
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

async function writeBlobStreaming(path: string, blob: Blob) {
  const { writeFile } = await import("@tauri-apps/plugin-fs");
  // One copy of the payload, not three.
  //
  // The previous "streaming" variant read the Blob into an array of chunks and
  // then merged those into one more contiguous buffer -- strictly more memory
  // than this for no benefit, since the whole Blob is resident either way and
  // the plugin call needs a contiguous buffer regardless.
  //
  // Bounded memory requires never materialising the Blob at all, which means
  // going URL -> file path entirely in Rust (`http_download_to_file`). That
  // command cannot carry auth headers yet, so it is not usable for API
  // downloads; until then this is the cheapest correct form.
  await writeFile(path, new Uint8Array(await blob.arrayBuffer()));
}

export async function saveBlob(blob: Blob, filename: string) {
  if (isTauri()) {
    const safeFilename = sanitizeDownloadFilename(filename);

    if (getRuntimeKind() === "mobile") {
      try {
        const [{ exists }, { downloadDir, join }] = await Promise.all([
          import("@tauri-apps/plugin-fs"),
          import("@tauri-apps/api/path"),
        ]);
        const downloads = await downloadDir();
        const { name, extension } = splitFilename(safeFilename);
        let targetPath = await join(downloads, safeFilename);
        for (let index = 1; await exists(targetPath); index += 1) {
          targetPath = await join(downloads, `${name} (${index})${extension}`);
        }
        await writeBlobStreaming(targetPath, blob);
        return;
      } catch (error) {
        console.warn("Tauri mobile download failed, falling back to browser download.", error);
      }
    } else {
      try {
        const [{ save }, { exists }, { downloadDir, join }] = await Promise.all([
          import("@tauri-apps/plugin-dialog"),
          import("@tauri-apps/plugin-fs"),
          import("@tauri-apps/api/path"),
        ]);
        const defaultPath = await join(await downloadDir(), safeFilename);
        const path = await save({ defaultPath });
        if (!path) return;
        void exists;
        await writeBlobStreaming(path, blob);
        return;
      } catch (error) {
        console.warn("Tauri download failed, falling back to browser download.", error);
      }
    }
  }

  saveBlobInBrowser(blob, filename);
}

function splitFilename(filename: string) {
  const dot = filename.lastIndexOf(".");
  if (dot <= 0) return { name: filename, extension: "" };
  return { name: filename.slice(0, dot), extension: filename.slice(dot) };
}

/** Desktop: stream a remote URL directly to a local path via Rust (no renderer Blob). */
export async function downloadUrlToLocalPath(url: string, path: string) {
  if (!isTauri() || getRuntimeKind() !== "desktop") {
    throw new Error("downloadUrlToLocalPath is only available in the desktop app");
  }
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<number>("http_download_to_file", { url, path });
}

export async function saveBlobToDownloads(blob: Blob, filename: string) {
  const safeFilename = sanitizeDownloadFilename(filename);
  if (isTauri()) {
    try {
      const [{ exists }, { downloadDir, join }] = await Promise.all([
        import("@tauri-apps/plugin-fs"),
        import("@tauri-apps/api/path"),
      ]);
      const downloads = await downloadDir();
      const { name, extension } = splitFilename(safeFilename);
      let targetPath = await join(downloads, safeFilename);
      for (let index = 1; await exists(targetPath); index += 1) {
        targetPath = await join(downloads, `${name} (${index})${extension}`);
      }
      await writeBlobStreaming(targetPath, blob);
      return targetPath;
    } catch (error) {
      console.warn("Tauri default download failed, falling back to browser download.", error);
    }
  }

  saveBlobInBrowser(blob, safeFilename);
  return safeFilename;
}
