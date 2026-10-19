import { lazy, Suspense, useEffect, type ReactNode } from "react";

import { browserRuntime } from "../../lib/runtime";
import { SshWorkspaceContext, useSshWorkspace, useSshWorkspaceStore } from "../../lib/use-ssh-workspace";
import { useAuth } from "../../lib/use-auth";

const AppSshTerminalDialog = lazy(() =>
  import("../tasks/AppSshTerminalDialog").then((module) => ({ default: module.AppSshTerminalDialog })),
);

/**
 * Provides the global in-app SSH workspace store (SSH-P2-11). Mounted once at
 * the app root, above every route, so terminal tabs survive page navigation.
 */
export function SshWorkspaceProvider({ children }: { children: ReactNode }) {
  const store = useSshWorkspaceStore();
  return <SshWorkspaceContext.Provider value={store}>{children}</SshWorkspaceContext.Provider>;
}

/**
 * Renders the singleton SSH workspace viewport and tears it down on logout:
 * unmounting the dialog runs every SshTerminalTab's cleanup effect, which
 * closes its native session, and the tab state resets so re-login starts
 * clean instead of showing sessions that belong to a signed-out account.
 */
export function SshWorkspaceGate() {
  const workspace = useSshWorkspace();
  const auth = useAuth();
  const authed = Boolean(auth.user);

  useEffect(() => {
    if (!authed && workspace.tabs.length > 0) {
      workspace.closeAllTabs();
    }
  }, [authed, workspace]);

  if (!authed || !browserRuntime.supportsInAppSsh || workspace.tabs.length === 0) return null;
  return (
    <Suspense fallback={null}>
      <AppSshTerminalDialog />
    </Suspense>
  );
}
