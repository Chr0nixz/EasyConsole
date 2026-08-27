import { useEffect, useState } from "react";

import { browserRuntime } from "./runtime";

/** Matches Tailwind `md` so compact lists appear with the bottom navigation. */
export const COMPACT_LAYOUT_QUERY = "(max-width: 767px)";

function readNarrowViewport() {
  if (typeof window.matchMedia !== "function") return false;
  return window.matchMedia(COMPACT_LAYOUT_QUERY).matches;
}

export function useCompactLayout() {
  const [narrow, setNarrow] = useState(readNarrowViewport);

  useEffect(() => {
    if (browserRuntime.isMobile) return;
    if (typeof window.matchMedia !== "function") return undefined;
    const media = window.matchMedia(COMPACT_LAYOUT_QUERY);
    const onChange = () => setNarrow(media.matches);
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);

  return browserRuntime.isMobile || narrow;
}
