import {
  ActivitySquare,
  Braces,
  Clock,
  CopyPlus,
  Download,
  FileText,
  Pencil,
  Pin,
  Save,
  TerminalSquare,
  Upload,
  type LucideIcon,
} from "lucide-react";

import type { TaskQuickActionId } from "../../lib/task-quick-actions";

/** One icon per quick action, shared by the row's action bar, More and the customization dialog. */
export const taskQuickActionIcons: Record<TaskQuickActionId, LucideIcon> = {
  terminal: TerminalSquare,
  log: FileText,
  monitor: ActivitySquare,
  clone: CopyPlus,
  extend: Clock,
  edit: Pencil,
  commit: Upload,
  download: Download,
  template: Save,
  pin: Pin,
  raw: Braces,
};
