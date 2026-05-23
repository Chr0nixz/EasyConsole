import { isTauri } from "@tauri-apps/api/core";

function saveBlobInBrowser(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.rel = "noreferrer";
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

export async function saveBlob(blob: Blob, filename: string) {
  if (isTauri()) {
    try {
      const [{ save }, { writeFile }, { downloadDir, join }] = await Promise.all([
        import("@tauri-apps/plugin-dialog"),
        import("@tauri-apps/plugin-fs"),
        import("@tauri-apps/api/path"),
      ]);
      const defaultPath = await join(await downloadDir(), filename);
      const path = await save({ defaultPath });
      if (!path) return;
      await writeFile(path, new Uint8Array(await blob.arrayBuffer()));
      return;
    } catch (error) {
      console.warn("Tauri download failed, falling back to browser download.", error);
    }
  }

  saveBlobInBrowser(blob, filename);
}
