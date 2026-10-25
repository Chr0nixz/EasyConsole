import { Dialog } from "./ui";
import { useI18n } from "../lib/i18n";
import { navItems } from "../lib/nav-items";
import { browserRuntime } from "../lib/runtime";

type ShortcutItem = {
  keys: string;
  labelKey: import("../lib/i18n").TranslationKey;
};

const GLOBAL_SHORTCUTS: ShortcutItem[] = [
  { keys: "Mod K", labelKey: "shell.shortcutsOpenCmd" },
  { keys: "/", labelKey: "shell.shortcutsSearch" },
  { keys: "?", labelKey: "shell.shortcutsShortcuts" },
];

const TASK_LIST_SHORTCUTS: ShortcutItem[] = [
  { keys: "j / k · ↑ / ↓", labelKey: "shell.shortcutsTaskMove" },
  { keys: "Enter", labelKey: "shell.shortcutsTaskOpen" },
  { keys: "l", labelKey: "shell.shortcutsTaskLog" },
  { keys: "t", labelKey: "shell.shortcutsTaskTerminal" },
  { keys: "x", labelKey: "shell.shortcutsTaskSelect" },
  { keys: "r", labelKey: "shell.shortcutsTaskRelease" },
];

function ShortcutKeys({ keys }: { keys: string }) {
  return (
    <kbd className="shrink-0 rounded border border-app-border bg-app-panel px-2 py-0.5 font-mono text-xs text-app-muted">
      {keys.replace("Mod", browserRuntime.isApplePlatform ? "⌘" : "Ctrl")}
    </kbd>
  );
}

export function ShortcutsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t, text } = useI18n();
  const sections = [
    { id: "global", title: text("全局", "Global"), items: GLOBAL_SHORTCUTS.map((item) => ({ keys: item.keys, label: t(item.labelKey) })) },
    { id: "pages", title: text("跳转页面（先按 g）", "Go to page (press g first)"), items: navItems.map((item) => ({ keys: item.shortcut, label: t(item.labelKey) })) },
    { id: "tasks", title: text("任务列表", "Task list"), items: TASK_LIST_SHORTCUTS.map((item) => ({ keys: item.keys, label: t(item.labelKey) })) },
  ];
  return (
    <Dialog open={open} title={t("shell.shortcutsTitle")} onClose={onClose} width="max-w-md">
      <div className="space-y-4 p-4">
        {sections.map((section) => (
          <section key={section.id} aria-labelledby={`shortcuts-${section.id}`}>
            <h3 id={`shortcuts-${section.id}`} className="mb-1.5 text-xs font-medium text-app-muted">
              {section.title}
            </h3>
            <ul className="space-y-1.5">
              {section.items.map((item) => (
                <li key={`${item.keys}-${item.label}`} className="flex items-center justify-between gap-3 text-sm">
                  <span className="text-app-text">{item.label}</span>
                  <ShortcutKeys keys={item.keys} />
                </li>
              ))}
            </ul>
          </section>
        ))}
        <p className="border-t border-app-border pt-3 text-xs leading-5 text-app-muted">
          {text(
            "在输入框中输入时快捷键会暂时失效。",
            "Shortcuts are disabled while typing in input fields.",
          )}
        </p>
      </div>
    </Dialog>
  );
}
