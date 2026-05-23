export const BATCH_REQUEST_DELAY_MS = 350;

export function delay(ms = BATCH_REQUEST_DELAY_MS) {
  return new Promise<void>((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

export async function runSequentiallyWithDelay<T>(items: T[], action: (item: T, index: number) => Promise<unknown>) {
  for (let index = 0; index < items.length; index += 1) {
    if (index > 0) await delay();
    await action(items[index], index);
  }
}

