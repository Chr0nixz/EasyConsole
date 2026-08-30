import { useCallback, useEffect, useMemo, useRef, type ReactNode } from "react";

import { useCompactLayout } from "./use-compact-layout";
import { MobileBackStackContext, type MobileBackStackContextValue } from "./use-mobile-back-stack";

type Layer = {
  id: number;
  handler: () => void;
};

const HISTORY_KEY = "__easyConsoleMobileBackLayer";

export function MobileBackStackProvider({ children }: { children: ReactNode }) {
  const compactLayout = useCompactLayout();
  const layersRef = useRef<Layer[]>([]);
  const nextIdRef = useRef(0);
  const suppressPopRef = useRef(false);
  const sentinelRef = useRef(false);

  const register = useCallback((handler: () => void) => {
    if (!compactLayout || typeof window === "undefined") return () => undefined;

    const id = ++nextIdRef.current;
    let disposed = false;
    layersRef.current.push({ id, handler });
    queueMicrotask(() => {
      if (disposed || !layersRef.current.some((layer) => layer.id === id)) return;
      if (sentinelRef.current && window.history.state?.[HISTORY_KEY]) return;
      window.history.pushState({ ...(window.history.state ?? {}), [HISTORY_KEY]: true }, "");
      sentinelRef.current = true;
    });

    return () => {
      disposed = true;
      const index = layersRef.current.findIndex((layer) => layer.id === id);
      if (index < 0) return;
      layersRef.current.splice(index, 1);
      if (layersRef.current.length === 0 && sentinelRef.current && window.history.state?.[HISTORY_KEY]) {
        suppressPopRef.current = true;
        sentinelRef.current = false;
        window.history.back();
      }
    };
  }, [compactLayout]);

  useEffect(() => {
    if (typeof window === "undefined") return undefined;

    const handlePopState = () => {
      if (suppressPopRef.current) {
        suppressPopRef.current = false;
        return;
      }
      const top = layersRef.current.at(-1);
      if (!top) {
        sentinelRef.current = false;
        return;
      }
      layersRef.current.pop();
      top.handler();
      if (layersRef.current.length > 0) {
        window.history.pushState({ ...(window.history.state ?? {}), [HISTORY_KEY]: true }, "");
        sentinelRef.current = true;
      } else {
        sentinelRef.current = false;
      }
    };

    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  const value = useMemo<MobileBackStackContextValue>(() => ({ register }), [register]);
  return <MobileBackStackContext.Provider value={value}>{children}</MobileBackStackContext.Provider>;
}
