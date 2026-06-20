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

export async function saveBlob(blob: Blob, filename: string) {
  if (isTauri()) {
    const safeFilename = sanitizeDownloadFilename(filename);

    // Mobile Tauri: no native save dialog, write directly to download dir
    if (getRuntimeKind() === "mobile") {
      try {
        const [{ exists, writeFile }, { downloadDir, join }] = await Promise.all([
          import("@tauri-apps/plugin-fs"),
          import("@tauri-apps/api/path"),
        ]);
        const downloads = await downloadDir();
        const { name, extension } = splitFilename(safeFilename);
        let targetPath = await join(downloads, safeFilename);
        for (let index = 1; await exists(targetPath); index += 1) {
          targetPath = await join(downloads, `${name} (${index})${extension}`);
        }
        await writeFile(targetPath, new Uint8Array(await blob.arrayBuffer()));
        return;
      } catch (error) {
        console.warn("Tauri mobile download failed, falling back to browser download.", error);
      }
    } else {
      try {
        const [{ save }, { writeFile }, { downloadDir, join }] = await Promise.all([
          import("@tauri-apps/plugin-dialog"),
          import("@tauri-apps/plugin-fs"),
          import("@tauri-apps/api/path"),
        ]);
        const defaultPath = await join(await downloadDir(), safeFilename);
        const path = await save({ defaultPath });
        if (!path) return;
        await writeFile(path, new Uint8Array(await blob.arrayBuffer()));
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

export async function saveBlobToDownloads(blob: Blob, filename: string) {
  const safeFilename = sanitizeDownloadFilename(filename);
  if (isTauri()) {
    try {
      const [{ exists, writeFile }, { downloadDir, join }] = await Promise.all([
        import("@tauri-apps/plugin-fs"),
        import("@tauri-apps/api/path"),
      ]);
      const downloads = await downloadDir();
      const { name, extension } = splitFilename(safeFilename);
      let targetPath = await join(downloads, safeFilename);
      for (let index = 1; await exists(targetPath); index += 1) {
        targetPath = await join(downloads, `${name} (${index})${extension}`);
      }
      await writeFile(targetPath, new Uint8Array(await blob.arrayBuffer()));
      return targetPath;
    } catch (error) {
      console.warn("Tauri default download failed, falling back to browser download.", error);
    }
  }

  saveBlobInBrowser(blob, safeFilename);
  return safeFilename;
}
