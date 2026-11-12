import type { ReactNode } from "react";
import { titleBarDragRegion, usesOverlayTitleBar } from "../lib/window-chrome";

/** Keeps the traffic lights and drag area above the scrolling sign-in pages. */
export function StandaloneWindow({ children, className }: { children: ReactNode; className: string }) {
  const page = <main className={className}>{children}</main>;
  if (!usesOverlayTitleBar()) return page;
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col bg-app-bg">
      <div aria-hidden="true" className="app-standalone-titlebar h-12 shrink-0" {...titleBarDragRegion()} />
      {page}
    </div>
  );
}
