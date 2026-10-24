import { useLayoutEffect, useRef, type RefObject } from "react";

type ExitTrack = [HTMLElement | null, Keyframe[]];
export type ExitPreset = (node: HTMLElement) => ExitTrack[];

const EXIT_EASE = "cubic-bezier(0.4, 0, 1, 1)";
const FADE_OUT: Keyframe[] = [{ opacity: 1 }, { opacity: 0 }];

function exitPanel(node: HTMLElement) {
  return node.querySelector<HTMLElement>("[data-exit-panel]");
}

export const exitPresets = {
  fade: (node) => [[node, FADE_OUT]],
  dialog: (node) => [
    [node, FADE_OUT],
    [exitPanel(node), [{ opacity: 1, transform: "none" }, { opacity: 0, transform: "translateY(6px) scale(0.97)" }]],
  ],
  drawer: (node) => {
    const panel = exitPanel(node);
    const sheet = panel?.dataset.exitPanel === "sheet" && window.matchMedia("(max-width: 639px)").matches;
    return [
      [node, FADE_OUT],
      [panel, [{ transform: "none" }, { transform: sheet ? "translateY(32px)" : "translateX(32px)" }]],
    ];
  },
  popover: (node) => [[node, [{ opacity: 1, transform: "none" }, { opacity: 0, transform: "translateY(-4px) scale(0.98)" }]]],
  sheet: (node) => [[node, [{ opacity: 1, transform: "none" }, { opacity: 0, transform: "translateY(12px)" }]]],
} satisfies Record<string, ExitPreset>;

/** Exit motion needs the Web Animations API and no reduced-motion preference (jsdom has neither). */
export function motionEnabled() {
  return (
    typeof window !== "undefined"
    && typeof Element !== "undefined"
    && typeof Element.prototype.animate === "function"
    && typeof window.matchMedia === "function"
    && !window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/**
 * React has already removed `node`; put it back for one short exit animation.
 * The ghost is inert and hidden from assistive technology, so the closed
 * surface is gone for every purpose except the eye.
 */
export function playExitGhost(node: HTMLElement | null, preset: ExitPreset, durationMs = 150) {
  if (!node || node.isConnected || !motionEnabled()) return;
  node.setAttribute("aria-hidden", "true");
  node.setAttribute("inert", "");
  node.classList.add("app-exit-ghost");
  document.body.appendChild(node);
  const remove = () => node.remove();
  const animations = preset(node).flatMap(([element, keyframes]) =>
    element ? [element.animate(keyframes, { duration: durationMs, easing: EXIT_EASE, fill: "forwards" })] : [],
  );
  void Promise.all(animations.map((animation) => animation.finished)).then(remove, remove);
  window.setTimeout(remove, durationMs + 120);
}

/** Plays `preset` on the last rendered `nodeRef` element when `open` turns false or the owner unmounts. */
export function useExitGhost(open: boolean, nodeRef: RefObject<HTMLElement | null>, preset: ExitPreset) {
  const lastNodeRef = useRef<HTMLElement | null>(null);

  useLayoutEffect(() => {
    if (open && nodeRef.current) lastNodeRef.current = nodeRef.current;
  });

  useLayoutEffect(() => {
    if (!open) return undefined;
    return () => {
      const node = lastNodeRef.current;
      // The closed subtree is detached later in the same commit; check once it has settled.
      queueMicrotask(() => playExitGhost(node, preset));
    };
  }, [open, preset]);
}
