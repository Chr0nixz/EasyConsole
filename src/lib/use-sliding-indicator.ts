import { useLayoutEffect, type RefObject } from "react";

export type SlidingIndicatorMode = "fill" | "underline";

/**
 * Glides one indicator element to whichever child of `containerRef` matches
 * `activeSelector`. Styles are written straight to the indicator node, so moving
 * the selection never re-renders the group. The container must be the
 * indicator's positioning context (`position: relative`).
 */
export function useSlidingIndicator(
  containerRef: RefObject<HTMLElement | null>,
  indicatorRef: RefObject<HTMLElement | null>,
  activeSelector: string,
  activeKey: unknown,
  mode: SlidingIndicatorMode = "fill",
) {
  useLayoutEffect(() => {
    const container = containerRef.current;
    const indicator = indicatorRef.current;
    if (!container || !indicator) return undefined;

    const place = () => {
      const active = container.querySelector<HTMLElement>(activeSelector);
      if (!active || active.offsetWidth === 0) {
        indicator.style.opacity = "0";
        return;
      }
      const height = mode === "underline" ? 2 : active.offsetHeight;
      const top = mode === "underline" ? active.offsetTop + active.offsetHeight - height : active.offsetTop;
      indicator.style.opacity = "1";
      indicator.style.width = `${active.offsetWidth}px`;
      indicator.style.height = `${height}px`;
      indicator.style.transform = `translate3d(${active.offsetLeft}px, ${top}px, 0)`;
    };

    place();
    // Enable the glide only after the first placement, so the indicator never flies in from the corner.
    const frame = window.requestAnimationFrame(() => {
      indicator.dataset.ready = "true";
    });
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(place);
    observer?.observe(container);
    return () => {
      window.cancelAnimationFrame(frame);
      observer?.disconnect();
    };
  }, [containerRef, indicatorRef, activeSelector, activeKey, mode]);
}
