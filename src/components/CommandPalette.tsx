import { useQuery } from "@tanstack/react-query";
import { CalendarClock, Database, Image, LayoutDashboard, ListFilter, Search, ScrollText, Server, Settings, SquareStack } from "lucide-react";
import { useEffect, useId, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";

import { instanceApi } from "../lib/api";
import { useI18n } from "../lib/i18n";
import type { Task } from "../lib/types";
import { Dialog, Input } from "./ui";

type PaletteCommand = {
  id: string;
  label: string;
  description: string;
  icon: typeof LayoutDashboard;
  run: () => void;
};

const REMOTE_SEARCH_DEBOUNCE_MS = 300;

function taskName(task: Task) {
  return task.name ?? task.task_name ?? task.description ?? String(task.task_id ?? task.id);
}

export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const navigate = useNavigate();
  const { t, text } = useI18n();
  const inputId = useId();
  const listboxId = useId();
  const [query, setQuery] = useState("");
  const [debouncedTaskQuery, setDebouncedTaskQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);

  const staticCommands = useMemo<PaletteCommand[]>(() => [
    { id: "dashboard", label: t("nav.dashboard"), description: "/dashboard", icon: LayoutDashboard, run: () => navigate("/dashboard") },
    { id: "tasks", label: t("nav.tasks"), description: "/tasks", icon: Server, run: () => navigate("/tasks") },
    { id: "scheduled", label: t("nav.scheduledTasks"), description: "/scheduled-tasks", icon: CalendarClock, run: () => navigate("/scheduled-tasks") },
    { id: "templates", label: t("nav.taskTemplates"), description: "/task-templates", icon: SquareStack, run: () => navigate("/task-templates") },
    { id: "storage", label: t("nav.storage"), description: "/storage", icon: Database, run: () => navigate("/storage") },
    { id: "images", label: t("nav.images"), description: "/images", icon: Image, run: () => navigate("/images") },
    { id: "logs", label: t("nav.runLogs"), description: "/run-logs", icon: ScrollText, run: () => navigate("/run-logs") },
    { id: "settings", label: t("nav.settings"), description: "/settings", icon: Settings, run: () => navigate("/settings") },
  ], [navigate, t]);

  const normalizedQuery = query.trim().toLowerCase();
  useEffect(() => {
    if (!open || normalizedQuery.length < 2) {
      setDebouncedTaskQuery("");
      return undefined;
    }

    const timer = window.setTimeout(() => setDebouncedTaskQuery(normalizedQuery), REMOTE_SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [normalizedQuery, open]);

  const taskQuery = useQuery({
    enabled: open && debouncedTaskQuery.length >= 2,
    queryKey: ["command-palette", "tasks", debouncedTaskQuery],
    queryFn: () => instanceApi.tasks({ page: 1, page_size: 50, keyword: debouncedTaskQuery }),
  });

  const commands = useMemo<PaletteCommand[]>(() => {
    const filtered = staticCommands.filter((command) => {
      if (!normalizedQuery) return true;
      return `${command.label} ${command.description}`.toLowerCase().includes(normalizedQuery);
    });
    const taskCommands = (taskQuery.data?.items ?? []).map((task): PaletteCommand => {
      const name = taskName(task);
      return {
        id: `task-${task.id}`,
        label: name,
        description: text("打开任务详情", "Open task detail"),
        icon: ListFilter,
        run: () => navigate(`/tasks/${task.id}`),
      };
    });
    return [...filtered, ...taskCommands];
  }, [navigate, normalizedQuery, staticCommands, taskQuery.data?.items, text]);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setDebouncedTaskQuery("");
    setActiveIndex(0);
  }, [open]);

  useEffect(() => {
    setActiveIndex(0);
  }, [normalizedQuery]);

  useEffect(() => {
    setActiveIndex((index) => (commands.length === 0 ? 0 : Math.min(index, commands.length - 1)));
  }, [commands.length]);

  function runActive() {
    const command = commands[activeIndex];
    if (!command) return;
    command.run();
    onClose();
  }

  const activeOptionId = commands[activeIndex] ? `${listboxId}-option-${activeIndex}` : undefined;

  return (
    <Dialog open={open} title={text("命令面板", "Command Palette")} onClose={onClose} width="max-w-2xl">
      <div className="p-3" onKeyDown={(event) => {
        if (event.key === "ArrowDown") {
          event.preventDefault();
          setActiveIndex((index) => Math.min(index + 1, Math.max(commands.length - 1, 0)));
        }
        if (event.key === "ArrowUp") {
          event.preventDefault();
          setActiveIndex((index) => Math.max(index - 1, 0));
        }
        if (event.key === "Home") {
          event.preventDefault();
          setActiveIndex(0);
        }
        if (event.key === "End") {
          event.preventDefault();
          setActiveIndex(Math.max(commands.length - 1, 0));
        }
        if (event.key === "Enter" && !event.nativeEvent.isComposing) {
          event.preventDefault();
          runActive();
        }
      }}>
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-app-muted" />
          <Input
            id={inputId}
            autoFocus
            className="w-full pl-9"
            value={query}
            placeholder={text("搜索页面、任务或操作", "Search pages, tasks, or actions")}
            role="combobox"
            aria-autocomplete="list"
            aria-controls={listboxId}
            aria-expanded={open}
            aria-activedescendant={activeOptionId}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <div
          id={listboxId}
          className="mt-3 max-h-[55vh] overflow-auto rounded-md border border-app-border"
          role="listbox"
          aria-label={text("命令结果", "Command results")}
          aria-busy={taskQuery.isFetching}
        >
          {commands.length === 0 ? (
            <div className="px-3 py-8 text-center text-sm text-app-muted" role="status">{text("没有匹配的命令", "No matching commands")}</div>
          ) : commands.map((command, index) => (
            <div
              key={command.id}
              id={`${listboxId}-option-${index}`}
              className={`flex w-full cursor-pointer select-none items-center gap-3 border-b border-app-border px-3 py-2 text-left text-sm last:border-0 ${index === activeIndex ? "bg-app-accentSoft text-app-accent" : "hover:bg-app-panel"}`}
              role="option"
              aria-selected={index === activeIndex}
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => setActiveIndex(index)}
              onClick={() => {
                command.run();
                onClose();
              }}
            >
              <command.icon className="h-4 w-4 shrink-0" />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{command.label}</span>
                <span className="block truncate text-xs text-app-muted">{command.description}</span>
              </span>
            </div>
          ))}
        </div>
      </div>
    </Dialog>
  );
}
