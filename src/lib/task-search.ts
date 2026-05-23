import { getTaskName } from "./format";
import type { Task } from "./types";

function primitiveText(value: unknown) {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

function searchableFields(task: Task) {
  return [getTaskName(task), task.name, task.task_name, task.description, task.id, task.task_id]
    .map((value) => primitiveText(value).trim().toLowerCase())
    .filter(Boolean);
}

function numericRank(fields: string[], keyword: string) {
  let best: number | null = null;
  for (const field of fields) {
    const tokens = field.match(/\d+/g) ?? [];
    for (const token of tokens) {
      let rank: number | null = null;
      if (token === keyword) rank = 0;
      else if (token.startsWith(keyword)) rank = 100 + token.length - keyword.length;
      else if (token.includes(keyword)) rank = 200 + token.indexOf(keyword) + token.length - keyword.length;
      if (rank !== null && (best === null || rank < best)) best = rank;
    }
  }
  return best;
}

function textRank(fields: string[], keyword: string) {
  let best: number | null = null;
  for (const field of fields) {
    let rank: number | null = null;
    if (field === keyword) rank = 0;
    else if (field.startsWith(keyword)) rank = 100 + field.length - keyword.length;
    else {
      const index = field.indexOf(keyword);
      if (index >= 0) rank = 200 + index + field.length - keyword.length;
    }
    if (rank !== null && (best === null || rank < best)) best = rank;
  }
  return best;
}

export function taskSearchRank(task: Task, keyword: string) {
  const normalizedKeyword = keyword.trim().toLowerCase();
  if (!normalizedKeyword) return 0;
  const fields = searchableFields(task);
  return /^\d+$/.test(normalizedKeyword) ? numericRank(fields, normalizedKeyword) : textRank(fields, normalizedKeyword);
}

export function filterAndSortTasks(tasks: Task[], keyword: string) {
  const normalizedKeyword = keyword.trim();
  if (!normalizedKeyword) return tasks;
  return tasks
    .map((task, index) => ({ index, rank: taskSearchRank(task, normalizedKeyword), task }))
    .filter((item): item is { index: number; rank: number; task: Task } => item.rank !== null)
    .sort((left, right) => left.rank - right.rank || left.index - right.index)
    .map((item) => item.task);
}
