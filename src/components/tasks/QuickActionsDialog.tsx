import { ArrowDown, ArrowUp, MoreHorizontal, Plus, Power, X } from "lucide-react";
import { useId, useRef } from "react";

import { useI18n } from "../../lib/i18n";
import {
  addTaskQuickAction,
  DEFAULT_TASK_QUICK_ACTIONS,
  MAX_TASK_QUICK_ACTIONS,
  moveTaskQuickAction,
  removeTaskQuickAction,
  TASK_QUICK_ACTION_IDS,
  taskQuickActionLabels,
  type TaskQuickActionId,
} from "../../lib/task-quick-actions";
import { Button, Dialog } from "../ui";
import { taskQuickActionIcons } from "./task-quick-action-icons";

type ControlKind = "up" | "down" | "remove" | "add";

const ROW_CLASS = "flex min-h-10 items-center gap-2 rounded-md px-2 text-sm text-app-text";

/**
 * Chooses which row actions sit on the task table's sticky action bar, and in what order.
 * Changes apply as they are made, like 列设置; release and More are always on the bar.
 */
export function QuickActionsDialog({
  open,
  actions,
  onChange,
  onClose,
}: {
  open: boolean;
  actions: readonly TaskQuickActionId[];
  onChange: (next: TaskQuickActionId[]) => void;
  onClose: () => void;
}) {
  const { text } = useI18n();
  const listRef = useRef<HTMLDivElement>(null);
  const descriptionId = useId();
  const onBarHeadingId = useId();
  const availableHeadingId = useId();
  const available = TASK_QUICK_ACTION_IDS.filter((id) => !actions.includes(id));
  const full = actions.length >= MAX_TASK_QUICK_ACTIONS;
  const label = (id: TaskQuickActionId) => text(taskQuickActionLabels[id].zh, taskQuickActionLabels[id].en);

  // The moved, added or removed action keeps the focus, wherever its row went; a move that
  // reaches the end of the list lands on the arrow that can still go the other way.
  const focusControl = (id: TaskQuickActionId, kinds: ControlKind[]) => {
    window.setTimeout(() => {
      for (const kind of kinds) {
        const control = listRef.current?.querySelector<HTMLButtonElement>(`[data-quick-action-control="${id}:${kind}"]`);
        if (control && !control.disabled && control.getAttribute("aria-disabled") !== "true") {
          control.focus();
          return;
        }
      }
    }, 0);
  };

  const move = (id: TaskQuickActionId, offset: -1 | 1) => {
    onChange(moveTaskQuickAction(actions, id, offset));
    focusControl(id, offset < 0 ? ["up", "down", "remove"] : ["down", "up", "remove"]);
  };

  return (
    <Dialog
      open={open}
      title={text("自定义操作栏", "Customize action bar")}
      describedBy={descriptionId}
      width="max-w-lg"
      onClose={onClose}
    >
      <div ref={listRef} className="space-y-4 p-4">
        <p id={descriptionId} className="text-xs leading-5 text-app-muted">
          {text(
            `选择每行右侧显示的快捷按钮，最多 ${MAX_TASK_QUICK_ACTIONS} 个；其余操作留在「更多」里。释放和「更多」始终显示。`,
            `Choose the shortcut buttons at the right of each row, up to ${MAX_TASK_QUICK_ACTIONS}. Everything else stays in More. Release and More are always shown.`,
          )}
        </p>

        {/* The bar as a row will draw it; the lists below are what a screen reader works with. */}
        <div aria-hidden="true" className="flex items-center justify-end gap-1 rounded-md border border-app-border bg-app-panel px-3 py-2">
          {actions.map((id) => {
            const Icon = taskQuickActionIcons[id];
            return (
              <span key={id} className="flex h-8 w-8 items-center justify-center text-app-muted">
                <Icon className="h-4 w-4" />
              </span>
            );
          })}
          <span className="flex h-8 w-16 items-center justify-center gap-2 text-sm font-medium text-app-muted">
            <Power className="h-4 w-4" />
            {text("释放", "Release")}
          </span>
          <span className="flex h-8 w-8 items-center justify-center text-app-muted">
            <MoreHorizontal className="h-4 w-4" />
          </span>
        </div>

        <div>
          <h3 id={onBarHeadingId} className="flex items-baseline justify-between text-xs font-medium text-app-muted">
            {text("操作栏上", "On the bar")}
            <span className="app-numeric font-normal">{actions.length} / {MAX_TASK_QUICK_ACTIONS}</span>
          </h3>
          {actions.length === 0 ? (
            <p className="mt-1 rounded-md border border-dashed border-app-border px-3 py-3 text-sm text-app-muted">
              {text("没有快捷按钮，每行只显示释放和「更多」。", "No shortcuts: each row shows only Release and More.")}
            </p>
          ) : (
            <ol aria-labelledby={onBarHeadingId} className="mt-1 space-y-0.5">
              {actions.map((id, index) => {
                const Icon = taskQuickActionIcons[id];
                const name = label(id);
                return (
                  <li key={id} className={`${ROW_CLASS} bg-app-panel`}>
                    <Icon className="h-4 w-4 shrink-0 text-app-muted" aria-hidden="true" />
                    <span className="min-w-0 flex-1 truncate">{name}</span>
                    <Button
                      aria-label={text(`上移 ${name}`, `Move ${name} up`)}
                      className="h-8 w-8 px-0"
                      data-quick-action-control={`${id}:up`}
                      disabled={index === 0}
                      title={text("上移", "Move up")}
                      type="button"
                      variant="ghost"
                      onClick={() => move(id, -1)}
                    >
                      <ArrowUp className="h-4 w-4" />
                    </Button>
                    <Button
                      aria-label={text(`下移 ${name}`, `Move ${name} down`)}
                      className="h-8 w-8 px-0"
                      data-quick-action-control={`${id}:down`}
                      disabled={index === actions.length - 1}
                      title={text("下移", "Move down")}
                      type="button"
                      variant="ghost"
                      onClick={() => move(id, 1)}
                    >
                      <ArrowDown className="h-4 w-4" />
                    </Button>
                    <Button
                      aria-label={text(`从操作栏移除 ${name}`, `Remove ${name} from the bar`)}
                      className="h-8 w-8 px-0"
                      data-quick-action-control={`${id}:remove`}
                      title={text("移除", "Remove")}
                      type="button"
                      variant="ghost"
                      onClick={() => {
                        onChange(removeTaskQuickAction(actions, id));
                        focusControl(id, ["add"]);
                      }}
                    >
                      <X className="h-4 w-4" />
                    </Button>
                  </li>
                );
              })}
            </ol>
          )}
        </div>

        {available.length > 0 ? (
          <div>
            <h3 id={availableHeadingId} className="text-xs font-medium text-app-muted">
              {text("在「更多」里", "In More")}
            </h3>
            <ul aria-labelledby={availableHeadingId} className="mt-1 space-y-0.5">
              {available.map((id) => {
                const Icon = taskQuickActionIcons[id];
                const name = label(id);
                return (
                  <li key={id} className={ROW_CLASS}>
                    <Icon className="h-4 w-4 shrink-0 text-app-muted" aria-hidden="true" />
                    <span className="min-w-0 flex-1 truncate">{name}</span>
                    <Button
                      aria-label={text(`添加 ${name} 到操作栏`, `Add ${name} to the bar`)}
                      className="h-8 px-2"
                      data-quick-action-control={`${id}:add`}
                      disabled={full}
                      disabledReason={full
                        ? text(`最多 ${MAX_TASK_QUICK_ACTIONS} 个，先移除一个`, `Up to ${MAX_TASK_QUICK_ACTIONS}; remove one first`)
                        : undefined}
                      title={text("添加", "Add")}
                      type="button"
                      variant="ghost"
                      onClick={() => {
                        onChange(addTaskQuickAction(actions, id));
                        focusControl(id, ["remove"]);
                      }}
                    >
                      <Plus className="h-4 w-4" />
                      {text("添加", "Add")}
                    </Button>
                  </li>
                );
              })}
            </ul>
          </div>
        ) : null}

        <p className="text-xs leading-5 text-app-muted">
          {text(
            "表格区域较窄时，快捷按钮会暂时收进「更多」，让状态、费用和释放条件留在视野内。",
            "When the table is narrow, the shortcuts fold into More so status, cost and the release condition stay in view.",
          )}
        </p>

        <div className="flex justify-end gap-2 border-t border-app-border pt-3">
          <Button type="button" variant="secondary" onClick={() => onChange([...DEFAULT_TASK_QUICK_ACTIONS])}>
            {text("恢复默认", "Restore defaults")}
          </Button>
          <Button type="button" onClick={onClose}>{text("完成", "Done")}</Button>
        </div>
      </div>
    </Dialog>
  );
}
