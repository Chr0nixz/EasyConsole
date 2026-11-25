import type { ImageItem } from "./types";

/** Whether the backend marks this image as the account's default (the Images page sets it). */
export function isDefaultImage(image: ImageItem) {
  return image.is_default === true || image.default === true || image.isDefault === true;
}

function numericScore(value: unknown) {
  if (typeof value !== "string" && typeof value !== "number") return 0;
  const digits = String(value).match(/\d+/g)?.join("") ?? "";
  const number = Number(digits);
  return Number.isFinite(number) ? number : 0;
}

function timeScore(value: unknown) {
  if (typeof value !== "string") return 0;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : 0;
}

function freshnessScore(image: ImageItem) {
  return Math.max(numericScore(image.tag), timeScore(image.update_time), timeScore(image.create_time), timeScore(image.created_at), numericScore(image.id));
}

/** The newest image by tag, timestamps or id; null for an empty list. */
export function getLatestImage(images: ImageItem[]) {
  return images.reduce<ImageItem | null>((latest, image) => {
    if (!latest) return image;
    return freshnessScore(image) > freshnessScore(latest) ? image : latest;
  }, null);
}

/**
 * The image every new instance form starts on (create, template, scheduled plan): the one the
 * user set as default on the Images page, otherwise the newest. One rule, so the three forms
 * never disagree about what "default" means.
 */
export function pickDefaultImage(images: ImageItem[]) {
  return images.find(isDefaultImage) ?? getLatestImage(images);
}
