import { Plus, X } from "lucide-react";
import { useState, type KeyboardEvent } from "react";

import { Button, Input } from "../ui";
import { useI18n } from "../../lib/i18n";
import { formatResourcePresetSummary, type ResourcePresetFormValues } from "../../lib/resource-presets";
import { cn } from "../../lib/utils";
import type { ResourcePreset } from "../../lib/types";

type ResourcePresetPickerProps = {
  presets: ResourcePreset[];
  onApply: (values: ResourcePresetFormValues) => void;
  onSaveCurrent: (name: string) => void;
  onDelete: (id: string) => void;
  /** Suggested preset name when opening the save form (usually the current values summary). */
  defaultName?: string;
  /** Disable saving while the current resource fields are invalid. */
  saveDisabled?: boolean;
  /** Explanation shown while saving is disabled. */
  saveDisabledReason?: string;
  /** Summary of the current form values; the matching preset chip is highlighted. */
  activeSummary?: string;
};

export function ResourcePresetPicker({
  presets,
  onApply,
  onSaveCurrent,
  onDelete,
  defaultName = "",
  saveDisabled = false,
  saveDisabledReason,
  activeSummary,
}: ResourcePresetPickerProps) {
  const { text } = useI18n();
  const [saveOpen, setSaveOpen] = useState(false);
  const [name, setName] = useState("");

  const trimmed = name.trim();
  const duplicate = presets.some((preset) => preset.name === trimmed);
  const saveDisabledTitle = saveDisabled ? saveDisabledReason : undefined;

  function openSaveForm() {
    setName(defaultName);
    setSaveOpen(true);
  }

  function submitSave() {
    if (!trimmed || saveDisabled) return;
    onSaveCurrent(trimmed);
    setSaveOpen(false);
  }

  // The picker lives inside the dialog's <form>; a nested form would be invalid
  // HTML, so Enter is handled here. isComposing keeps IME confirmations
  // (Chinese input) from submitting while composition is still active.
  function handleNameKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Escape") {
      // Escape cancels just this field; it must not reach the dialog's discard prompt.
      event.preventDefault();
      event.stopPropagation();
      setSaveOpen(false);
      return;
    }
    if (event.key !== "Enter") return;
    event.preventDefault();
    submitSave();
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-app-muted">{text("资源预设", "Resource presets")}</span>
        {presets.length === 0 && !saveOpen ? (
          <span className="text-xs text-app-muted">
            {text("暂无预设，可保存当前资源配置", "No presets yet; save the current resources as a preset")}
          </span>
        ) : null}
        {presets.map((preset) => {
          const summary = formatResourcePresetSummary(preset);
          const active = activeSummary === summary;
          return (
            <div
              key={preset.id}
              className={cn(
                "inline-flex items-stretch divide-x overflow-hidden rounded-md border text-xs",
                active ? "border-app-accent bg-app-panel" : "border-app-borderStrong bg-app-surface",
              )}
            >
              <button
                type="button"
                className="app-interactive px-2 py-1 text-left hover:bg-app-panel"
                aria-pressed={active}
                aria-label={text(`应用预设 ${preset.name}（${summary}）`, `Apply preset ${preset.name} (${summary})`)}
                title={text(`应用预设 ${preset.name}`, `Apply preset ${preset.name}`)}
                onClick={() =>
                  onApply({ cpu: String(preset.cpu), gpu: String(preset.gpu), memory: String(preset.memory) })
                }
              >
                <span className="font-medium">{preset.name}</span>
                <span className="ml-1.5 text-app-muted">{summary}</span>
              </button>
              <button
                type="button"
                className="app-interactive flex w-8 items-center justify-center text-app-muted hover:bg-app-dangerSoft hover:text-app-danger"
                aria-label={text(`删除预设 ${preset.name}`, `Delete preset ${preset.name}`)}
                title={text(`删除预设 ${preset.name}`, `Delete preset ${preset.name}`)}
                onClick={() => onDelete(preset.id)}
              >
                <X aria-hidden="true" className="h-3 w-3" />
              </button>
            </div>
          );
        })}
        {!saveOpen ? (
          <Button
            type="button"
            variant="ghost"
            className="h-7 gap-1 px-2 text-xs"
            disabled={saveDisabled}
            title={saveDisabledTitle}
            onClick={openSaveForm}
          >
            <Plus aria-hidden="true" className="h-3.5 w-3.5" />
            {text("存为预设", "Save as preset")}
          </Button>
        ) : null}
      </div>
      {saveOpen ? (
        <div className="flex flex-wrap items-center gap-2">
          <Input
            aria-label={text("预设名称", "Preset name")}
            autoFocus
            className="h-7 w-48 px-2 text-xs"
            value={name}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={handleNameKeyDown}
          />
          <Button type="button" variant="secondary" className="h-7 px-2 text-xs" disabled={!trimmed || saveDisabled} title={saveDisabledTitle} onClick={submitSave}>
            {duplicate ? text("更新预设", "Update preset") : text("保存预设", "Save preset")}
          </Button>
          <Button type="button" variant="ghost" className="h-7 px-2 text-xs" onClick={() => setSaveOpen(false)}>
            {text("取消", "Cancel")}
          </Button>
          {duplicate ? (
            <span className="text-xs text-app-muted">{text("同名预设将被更新", "A preset with this name will be updated")}</span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
