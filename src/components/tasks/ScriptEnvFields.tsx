import { ChevronDown, ChevronRight, Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";

import { FieldError } from "../form-fields";
import { Button, Input } from "../ui";
import { useI18n } from "../../lib/i18n";
import { previewScriptCommand, type ScriptEnvVar } from "../../lib/script-command-env";
import { cn } from "../../lib/utils";

type ScriptEnvFieldsProps = {
  envVars: ScriptEnvVar[];
  scriptPath: string;
  onChange: (envVars: ScriptEnvVar[]) => void;
  error?: string;
  /** Controlled expand state; when omitted, defaults to open only when vars exist. */
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
};

export function ScriptEnvFields({
  envVars,
  scriptPath,
  onChange,
  error,
  expanded: expandedProp,
  onExpandedChange,
}: ScriptEnvFieldsProps) {
  const { text } = useI18n();
  const filledCount = envVars.filter((item) => item.key.trim() || item.value.trim()).length;
  const controlled = expandedProp !== undefined;
  const [uncontrolledExpanded, setUncontrolledExpanded] = useState(filledCount > 0);
  const expanded = controlled ? Boolean(expandedProp) : uncontrolledExpanded;

  useEffect(() => {
    if (controlled || filledCount === 0) return;
    setUncontrolledExpanded(true);
  }, [controlled, filledCount]);

  function setExpanded(next: boolean) {
    if (controlled) onExpandedChange?.(next);
    else setUncontrolledExpanded(next);
  }

  const preview = previewScriptCommand(scriptPath, envVars);

  function updateRow(index: number, patch: Partial<ScriptEnvVar>) {
    onChange(envVars.map((item, i) => (i === index ? { ...item, ...patch } : item)));
  }

  function removeRow(index: number) {
    onChange(envVars.filter((_, i) => i !== index));
  }

  function addRow() {
    setExpanded(true);
    onChange([...envVars, { key: "", value: "" }]);
  }

  return (
    <div className="space-y-2 rounded-md border border-app-border bg-app-panel/40">
      <button
        type="button"
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm"
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
      >
        {expanded ? <ChevronDown className="h-4 w-4 shrink-0 text-app-muted" /> : <ChevronRight className="h-4 w-4 shrink-0 text-app-muted" />}
        <span className="font-medium text-app-text">{text("环境变量", "Environment variables")}</span>
        <span className="text-xs text-app-muted">
          {filledCount > 0
            ? text(`${filledCount} 项`, `${filledCount} set`)
            : text("可选，默认折叠", "Optional, collapsed by default")}
        </span>
      </button>

      {expanded ? (
        <div className="space-y-2 border-t border-app-border px-3 pb-3 pt-2">
          {envVars.length === 0 ? (
            <p className="text-xs text-app-muted">{text("尚未添加环境变量。", "No environment variables yet.")}</p>
          ) : (
            <div className="space-y-2">
              {envVars.map((item, index) => (
                <div key={index} className="grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
                  <Input
                    className="min-w-0 w-full font-mono text-xs"
                    placeholder={text("名称，如 EXPERIMENT_ID", "Name, e.g. EXPERIMENT_ID")}
                    value={item.key}
                    onChange={(event) => updateRow(index, { key: event.target.value })}
                  />
                  <Input
                    className="min-w-0 w-full font-mono text-xs"
                    placeholder={text("值", "Value")}
                    value={item.value}
                    onChange={(event) => updateRow(index, { value: event.target.value })}
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    className="h-9 w-9 shrink-0 justify-self-end px-0 text-app-danger hover:text-app-danger"
                    title={text("删除", "Remove")}
                    onClick={() => removeRow(index)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              ))}
            </div>
          )}
          <Button type="button" variant="secondary" className="h-8" onClick={addRow}>
            <Plus className="h-4 w-4" />
            {text("添加变量", "Add variable")}
          </Button>
          <FieldError message={error} />
        </div>
      ) : null}

      <div className={cn("border-t border-app-border px-3 py-2", !expanded && "rounded-b-md")}>
        <div className="mb-1 text-xs text-app-muted">{text("最终命令预览", "Final command preview")}</div>
        <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded-md bg-app-surface px-2 py-1.5 font-mono text-xs text-app-text">
          {preview || text("（填写脚本路径后显示）", "(Shown after script path is set)")}
        </pre>
      </div>
    </div>
  );
}
