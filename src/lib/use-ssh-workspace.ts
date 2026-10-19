import { createContext, useCallback, useContext, useRef, useState } from "react";

import { i18nText } from "./i18n-text";
import type { SshConnectionRequest, SshTabStatusKind } from "./types";

export type SshWorkspaceTab = {
  id: string;
  request: SshConnectionRequest;
  status: string;
  kind: SshTabStatusKind;
};

export type SshWorkspaceStore = {
  tabs: SshWorkspaceTab[];
  activeTabId: string | null;
  isMinimized: boolean;
  /** Opens a tab for the target, or activates the existing tab with the same target. */
  openTarget: (request: SshConnectionRequest) => void;
  /** Always opens a fresh tab (the manual new-tab form). */
  openTab: (request: SshConnectionRequest) => void;
  closeTab: (id: string) => void;
  closeAllTabs: () => void;
  setActiveTabId: (id: string) => void;
  updateTabStatus: (id: string, status: string, kind: SshTabStatusKind) => void;
  setMinimized: (minimized: boolean) => void;
};

export const SshWorkspaceContext = createContext<SshWorkspaceStore | null>(null);

/** Accesses the global in-app SSH workspace (SSH-P2-11). */
export function useSshWorkspace(): SshWorkspaceStore {
  const store = useContext(SshWorkspaceContext);
  if (!store) {
    throw new Error("useSshWorkspace must be used inside SshWorkspaceProvider");
  }
  return store;
}

function sameTarget(a: SshConnectionRequest, b: SshConnectionRequest) {
  return a.host === b.host && a.port === b.port && a.username === b.username && a.taskId === b.taskId;
}

function newTabId() {
  return typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `tab-${Date.now()}`;
}

function initialStatus() {
  return i18nText("准备连接", "Ready to connect");
}

/**
 * Owns the tab state for the global SSH workspace. The state lives here, far
 * above any route, so navigating between pages (SSH-P2-11) or switching the
 * language never unmounts the terminal tabs; only closing a tab, closing the
 * workspace, or logging out ends a session.
 */
export function useSshWorkspaceStore(): SshWorkspaceStore {
  const [tabs, setTabs] = useState<SshWorkspaceTab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const activeTabIdRef = useRef<string | null>(null);
  const [isMinimized, setIsMinimized] = useState(false);

  const activate = useCallback((id: string) => {
    activeTabIdRef.current = id;
    setActiveTabId(id);
  }, []);

  const openTarget = useCallback(
    (request: SshConnectionRequest) => {
      const existing = tabs.find((tab) => sameTarget(tab.request, request));
      if (existing) {
        activate(existing.id);
      } else {
        const id = newTabId();
        setTabs((prev) => [...prev, { id, request, status: initialStatus(), kind: "ready" }]);
        activate(id);
      }
      setIsMinimized(false);
    },
    [tabs, activate],
  );

  const openTab = useCallback(
    (request: SshConnectionRequest) => {
      const id = newTabId();
      setTabs((prev) => [...prev, { id, request, status: initialStatus(), kind: "ready" }]);
      activate(id);
      setIsMinimized(false);
    },
    [activate],
  );

  const closeTab = useCallback((id: string) => {
    setTabs((prev) => {
      const idx = prev.findIndex((tab) => tab.id === id);
      if (idx === -1) return prev;
      const next = prev.filter((tab) => tab.id !== id);
      if (next.length === 0) {
        activeTabIdRef.current = null;
        setActiveTabId(null);
        setIsMinimized(false);
        return next;
      }
      if (id === activeTabIdRef.current) {
        const fallback = next[Math.min(idx, next.length - 1)];
        activeTabIdRef.current = fallback.id;
        setActiveTabId(fallback.id);
      }
      return next;
    });
  }, []);

  const closeAllTabs = useCallback(() => {
    setTabs([]);
    activeTabIdRef.current = null;
    setActiveTabId(null);
    setIsMinimized(false);
  }, []);

  const updateTabStatus = useCallback((id: string, status: string, kind: SshTabStatusKind) => {
    setTabs((prev) => {
      const current = prev.find((tab) => tab.id === id);
      if (!current || (current.status === status && current.kind === kind)) return prev;
      return prev.map((tab) => (tab.id === id ? { ...tab, status, kind } : tab));
    });
  }, []);

  return {
    tabs,
    activeTabId,
    isMinimized,
    openTarget,
    openTab,
    closeTab,
    closeAllTabs,
    setActiveTabId: activate,
    updateTabStatus,
    setMinimized: setIsMinimized,
  };
}
