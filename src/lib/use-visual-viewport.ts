import { useEffect, useState } from "react";

export type VisualViewportMetrics = {
  height: number;
  offsetTop: number;
  bottomInset: number;
};

function readVisualViewport(): VisualViewportMetrics {
  if (typeof window === "undefined") {
    return { height: 0, offsetTop: 0, bottomInset: 0 };
  }

  const viewport = window.visualViewport;
  const height = Math.round(viewport?.height ?? window.innerHeight);
  const offsetTop = Math.round(viewport?.offsetTop ?? 0);
  return {
    height,
    offsetTop,
    bottomInset: Math.max(0, Math.round(window.innerHeight - (height + offsetTop))),
  };
}

/**
 * Tracks the usable browser viewport while mobile software keyboards resize
 * or shift it. Desktop callers receive the normal window dimensions.
 */
export function useVisualViewport(active = true) {
  const [metrics, setMetrics] = useState(readVisualViewport);

  useEffect(() => {
    if (!active || typeof window === "undefined") return undefined;
    const viewport = window.visualViewport;
    const update = () => setMetrics(readVisualViewport());

    update();
    viewport?.addEventListener("resize", update);
    viewport?.addEventListener("scroll", update);
    window.addEventListener("resize", update);
    return () => {
      viewport?.removeEventListener("resize", update);
      viewport?.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, [active]);

  return metrics;
}
