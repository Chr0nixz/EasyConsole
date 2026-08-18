import type { TaskListQueryState } from "./task-list-query";

export const queryKeys = {
  images: {
    all: ["images"] as const,
    list: () => ["images", "list"] as const,
    system: () => ["images", "system"] as const,
  },
  tasks: {
    all: ["tasks"] as const,
    list: (state: Pick<TaskListQueryState, "page" | "pageSize" | "keyword" | "status" | "sortBy" | "sortDir">) =>
      ["tasks", "list", state.page, state.pageSize, state.keyword, state.status, state.sortBy, state.sortDir] as const,
  },
};
