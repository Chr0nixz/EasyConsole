import { useEffect, useRef, type MutableRefObject } from "react";

/**
 * Open overlays in the order they opened. Every dialog, drawer, sheet and popover listens for
 * keys on the document, so a picker or confirm stacked over a dialog would otherwise see the
 * same Escape as the dialog beneath it. Only the topmost overlay may claim a key.
 */
export type OverlayKind = "modal" | "popover";

export type OverlayHandle = {
  readonly kind: OverlayKind;
  isTop: () => boolean;
  release: () => void;
};

const overlays: OverlayHandle[] = [];
// A key is answered once: if the top overlay closes and unregisters while the same event is
// still dispatching, the overlay beneath must not treat itself as top and answer it again.
const claimedEvents = new WeakSet<Event>();

export function openOverlay(kind: OverlayKind): OverlayHandle {
  const handle: OverlayHandle = {
    kind,
    isTop: () => overlays[overlays.length - 1] === handle,
    release: () => {
      const index = overlays.indexOf(handle);
      if (index !== -1) overlays.splice(index, 1);
    },
  };
  overlays.push(handle);
  return handle;
}

/** True when a modal dialog, drawer or sheet is open; page-level shortcuts stand down then. */
export function hasOpenModalOverlay() {
  return overlays.some((overlay) => overlay.kind === "modal");
}

/** Claims a key event for `handle` when it is the topmost overlay and nothing has answered it yet. */
export function claimOverlayKey(handle: OverlayHandle | null, event: Event) {
  if (claimedEvents.has(event)) return false;
  if (handle && !handle.isTop()) return false;
  claimedEvents.add(event);
  return true;
}

/** Registers an overlay for as long as `open` holds, independent of the owner's other effects. */
export function useOverlay(open: boolean, kind: OverlayKind): MutableRefObject<OverlayHandle | null> {
  const handleRef = useRef<OverlayHandle | null>(null);
  useEffect(() => {
    if (!open) return undefined;
    const handle = openOverlay(kind);
    handleRef.current = handle;
    return () => {
      handle.release();
      if (handleRef.current === handle) handleRef.current = null;
    };
  }, [open, kind]);
  return handleRef;
}
