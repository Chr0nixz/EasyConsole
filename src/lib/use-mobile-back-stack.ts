import { createContext, useContext, useEffect, useRef, type MutableRefObject } from "react";

type MobileBackHandler = () => void;

export type MobileBackStackContextValue = {
  register: (handler: MobileBackHandler) => () => void;
};

export const MobileBackStackContext = createContext<MobileBackStackContextValue | null>(null);

/**
 * Registers a transient mobile layer in browser history. Android's system
 * back gesture then closes the top-most dialog/drawer before routing back.
 */
export function useMobileBackLayer(active: boolean, onBack: MobileBackHandler) {
  const context = useContext(MobileBackStackContext);
  const onBackRef: MutableRefObject<MobileBackHandler> = useRef(onBack);
  useEffect(() => {
    onBackRef.current = onBack;
  }, [onBack]);

  useEffect(() => {
    if (!active || !context) return undefined;
    return context.register(() => onBackRef.current());
  }, [active, context]);
}

export function useMobileBackStack() {
  return useContext(MobileBackStackContext);
}
