import { useCallback, useEffect, useState } from "react";

import { i18nText } from "./i18n-text";
import {
  deleteResourcePreset,
  loadResourcePresets,
  saveResourcePresets,
  upsertResourcePreset,
  type EditableResourcePreset,
} from "./resource-presets";
import type { ResourcePreset, RuntimeStorage } from "./types";
import { useToast } from "./use-toast";

/**
 * Local resource presets for one dialog session. Loads while `active` and always
 * re-reads storage before mutating so concurrent windows cannot clobber entries.
 */
export function useResourcePresets(storage: RuntimeStorage, active: boolean) {
  const toast = useToast();
  const [presets, setPresets] = useState<ResourcePreset[]>([]);

  useEffect(() => {
    if (!active) return;
    void loadResourcePresets(storage).then(setPresets);
  }, [active, storage]);

  const savePreset = useCallback(
    async (input: EditableResourcePreset) => {
      try {
        const next = upsertResourcePreset(await loadResourcePresets(storage), input);
        await saveResourcePresets(storage, next);
        setPresets(next);
        toast.success(i18nText("资源预设已保存", "Resource preset saved"), input.name.trim());
      } catch (error) {
        toast.error(
          i18nText("资源预设保存失败", "Failed to save resource preset"),
          error instanceof Error ? error.message : i18nText("请稍后重试", "Try again later"),
        );
      }
    },
    [storage, toast],
  );

  const deletePreset = useCallback(
    async (id: string) => {
      try {
        const current = await loadResourcePresets(storage);
        const removed = current.find((preset) => preset.id === id);
        const next = deleteResourcePreset(current, id);
        await saveResourcePresets(storage, next);
        setPresets(next);
        // Deleting is one click with no confirm, so the toast carries the way back.
        const undo = removed
          ? {
              label: i18nText("撤销", "Undo"),
              onClick: () => {
                void (async () => {
                  const latest = await loadResourcePresets(storage);
                  if (latest.some((preset) => preset.id === removed.id)) return;
                  const restored = [...latest, removed];
                  await saveResourcePresets(storage, restored);
                  setPresets(restored);
                })();
              },
            }
          : undefined;
        toast.success(i18nText("资源预设已删除", "Resource preset deleted"), removed?.name, undo);
      } catch (error) {
        toast.error(
          i18nText("资源预设删除失败", "Failed to delete resource preset"),
          error instanceof Error ? error.message : i18nText("请稍后重试", "Try again later"),
        );
      }
    },
    [storage, toast],
  );

  return { presets, savePreset, deletePreset };
}
