import { Dialog } from "./ui";
import { useI18n } from "../lib/i18n";

type ShortcutItem = {
  keys: string;
  labelKey: import("../lib/i18n").TranslationKey;
};

const SHORTCUTS: ShortcutItem[] = [
  { keys: "Ctrl K", labelKey: "shell.shortcutsOpenCmd" },
  { keys: "/", labelKey: "shell.shortcutsSearch" },
  { keys: "g d / g t / g c / g m / g s / g i / g r / g e", labelKey: "shell.shortcutsNav" },
  { keys: "?", labelKey: "shell.shortcutsShortcuts" },
  { keys: "← / →", labelKey: "shell.shortcutsResize" },
  { keys: "Enter", labelKey: "shell.shortcutsReset" },
  { keys: "j / k · ↑ / ↓", labelKey: "shell.shortcutsTaskMove" },
  { keys: "Enter", labelKey: "shell.shortcutsTaskOpen" },
  { keys: "l", labelKey: "shell.shortcutsTaskLog" },
  { keys: "t", labelKey: "shell.shortcutsTaskTerminal" },
  { keys: "r", labelKey: "shell.shortcutsTaskRelease" },
];

export function ShortcutsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t, text } = useI18n();
  return (
    <Dialog open={open} title={t("shell.shortcutsTitle")} onClose={onClose} width="max-w-md">
      <div className="p-4">
        <ul className="space-y-2">
          {SHORTCUTS.map((item) => (
            <li key={item.labelKey} className="flex items-center justify-between gap-3 text-sm">
              <span className="text-app-text">{t(item.labelKey)}</span>
              <kbd className="shrink-0 rounded border border-app-border bg-app-panel px-2 py-0.5 font-mono text-xs text-app-muted">
                {item.keys}
              </kbd>
            </li>
          ))}
        </ul>
        <p className="mt-4 border-t border-app-border pt-3 text-xs leading-5 text-app-muted">
          {text(
            "在输入框中输入时快捷键会暂时失效。",
            "Shortcuts are disabled while typing in input fields.",
          )}
        </p>
      </div>
    </Dialog>
  );
}
