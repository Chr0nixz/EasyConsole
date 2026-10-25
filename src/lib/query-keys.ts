import { getActiveAccountScope } from "./account-scope";
import type { TaskListQueryState } from "./task-list-query";

/**
 * React Query keys are prefixed with the active account scope (see
 * account-scope.ts) so data cached for one account can never be shown or
 * refilled for another. The scope is read at key-build time; auth-context
 * updates it before the new session's first render.
 */
function accountRoot(): readonly [string, string] {
  return ["account", getActiveAccountScope().key];
}

export const queryKeys = {
  images: {
    get all() {
      return [...accountRoot(), "images"] as const;
    },
    list: () => [...accountRoot(), "images", "list"] as const,
    system: () => [...accountRoot(), "images", "system"] as const,
  },
  tasks: {
    get all() {
      return [...accountRoot(), "tasks"] as const;
    },
    list: (state: Pick<TaskListQueryState, "page" | "pageSize" | "keyword" | "status" | "sortBy" | "sortDir">) =>
      [...accountRoot(), "tasks", "list", state.page, state.pageSize, state.keyword, state.status, state.sortBy, state.sortDir] as const,
  },
};
