import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState, type Dispatch, type SetStateAction } from "react";
import { useSearchParams } from "react-router-dom";
import type { RowSelectionState } from "@tanstack/react-table";

import { instanceApi } from "../../lib/api";
import { queryKeys } from "../../lib/query-keys";
import { sortTasksWithPins } from "../../lib/task-pins";
import { filterAndSortTasks } from "../../lib/task-search";
import {
  parseTaskListQuery,
  serializeTaskListQuery,
  sortTasksClientSide,
  taskMatchesQuery,
  toTaskApiQuery,
  type TaskListQueryState,
} from "../../lib/task-list-query";
import { TASK_SNAPSHOT_QUERY_KEY } from "../../lib/task-snapshot-query";

export function useTaskListController({
  pinnedTaskIds,
  autoRefresh,
  autoRefreshInterval,
  autoRefreshPaused,
}: {
  pinnedTaskIds: string[];
  autoRefresh: boolean;
  autoRefreshInterval: number;
  autoRefreshPaused: boolean;
}) {
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const queryState = useMemo(() => parseTaskListQuery(searchParams), [searchParams]);
  const [keywordInput, setKeywordInput] = useState(queryState.keyword);
  const [activeRowIndex, setActiveRowIndex] = useState(0);
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({});

  const updateTaskQuery = useCallback(
    (patch: Partial<TaskListQueryState>) => {
      const next = { ...queryState, ...patch };
      if (!("page" in patch)) next.page = 1;
      setSearchParams(serializeTaskListQuery(next), { replace: true });
    },
    [queryState, setSearchParams],
  );

  useEffect(() => {
    if (keywordInput === queryState.keyword) return;
    const timer = window.setTimeout(() => {
      updateTaskQuery({ keyword: keywordInput });
    }, 300);
    return () => window.clearTimeout(timer);
  }, [keywordInput, queryState.keyword, updateTaskQuery]);

  useEffect(() => {
    setKeywordInput(queryState.keyword);
  }, [queryState.keyword]);

  const query = useQuery({
    queryKey: queryKeys.tasks.list(queryState),
    queryFn: ({ signal }) => instanceApi.tasks(toTaskApiQuery(queryState), { signal }),
    placeholderData: (previous) => previous,
    refetchInterval: autoRefresh && !autoRefreshPaused ? autoRefreshInterval : false,
    refetchIntervalInBackground: false,
  });

  useEffect(() => {
    if (query.data) {
      queryClient.setQueryData(TASK_SNAPSHOT_QUERY_KEY, query.data);
    }
  }, [query.data, queryClient]);

  const filteredTasks = useMemo(() => {
    const tasks = query.data?.items ?? [];
    const matched = filterAndSortTasks(tasks.filter((task) => taskMatchesQuery(task, queryState)), queryState.keyword);
    const pinned = sortTasksWithPins(matched, pinnedTaskIds);
    return sortTasksClientSide(pinned, queryState.sortBy, queryState.sortDir);
  }, [pinnedTaskIds, query.data?.items, queryState]);

  const total = query.data?.total;
  const hasKnownTotal = typeof total === "number";
  const totalPages = hasKnownTotal ? Math.max(1, Math.ceil(total / queryState.pageSize)) : undefined;
  const hasNextPage = hasKnownTotal
    ? queryState.page < (totalPages ?? 1)
    : (query.data?.items.length ?? 0) >= queryState.pageSize;

  useEffect(() => {
    setRowSelection({});
  }, [queryState.page, queryState.pageSize, queryState.keyword, queryState.status, queryState.sortBy, queryState.sortDir]);

  useEffect(() => {
    setActiveRowIndex((index) => {
      if (filteredTasks.length === 0) return 0;
      return Math.min(index, filteredTasks.length - 1);
    });
  }, [filteredTasks.length]);

  return {
    queryState,
    keywordInput,
    setKeywordInput,
    updateTaskQuery,
    query,
    filteredTasks,
    activeRowIndex,
    setActiveRowIndex,
    rowSelection,
    setRowSelection,
    total,
    hasKnownTotal,
    totalPages,
    hasNextPage,
  };
}

export type TaskListController = ReturnType<typeof useTaskListController>;
export type SetActiveRowIndex = Dispatch<SetStateAction<number>>;
