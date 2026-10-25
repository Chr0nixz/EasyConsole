import { CalendarClock, Database, Image, LayoutDashboard, ScrollText, Server, Settings, SquareStack } from "lucide-react";

/**
 * Protected routes in sidebar order, with the `g` chord that jumps to each.
 * Shared by the shell navigation and the shortcuts dialog so the two never disagree.
 */
export const navItems = [
  { to: "/dashboard", labelKey: "nav.dashboard", icon: LayoutDashboard, shortcut: "g d" },
  { to: "/tasks", labelKey: "nav.tasks", icon: Server, shortcut: "g t" },
  { to: "/scheduled-tasks", labelKey: "nav.scheduledTasks", icon: CalendarClock, shortcut: "g c" },
  { to: "/task-templates", labelKey: "nav.taskTemplates", icon: SquareStack, shortcut: "g m" },
  { to: "/storage", labelKey: "nav.storage", icon: Database, shortcut: "g s" },
  { to: "/images", labelKey: "nav.images", icon: Image, shortcut: "g i" },
  { to: "/run-logs", labelKey: "nav.runLogs", icon: ScrollText, shortcut: "g r" },
  { to: "/settings", labelKey: "nav.settings", icon: Settings, shortcut: "g e" },
] as const;
