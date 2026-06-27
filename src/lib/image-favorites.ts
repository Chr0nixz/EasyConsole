import type { RuntimeStorage } from "./types";

export const IMAGE_FAVORITES_STORAGE_KEY = "easy-console.favoriteImages";

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

export async function loadFavoriteImages(storage: RuntimeStorage): Promise<string[]> {
  const raw = await storage.get(IMAGE_FAVORITES_STORAGE_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return isStringArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function saveFavoriteImages(storage: RuntimeStorage, ids: string[]): Promise<void> {
  await storage.set(IMAGE_FAVORITES_STORAGE_KEY, JSON.stringify(ids));
}

export async function toggleFavoriteImage(storage: RuntimeStorage, id: string | number): Promise<string[]> {
  const idStr = String(id);
  const current = await loadFavoriteImages(storage);
  const next = current.includes(idStr) ? current.filter((item) => item !== idStr) : [...current, idStr];
  await saveFavoriteImages(storage, next);
  return next;
}
