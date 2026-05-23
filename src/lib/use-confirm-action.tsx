import { useCallback, useMemo, useState } from "react";

import { ConfirmDialog, type ConfirmOptions } from "../components/ConfirmDialog";

export function useConfirmAction() {
  const [options, setOptions] = useState<ConfirmOptions | null>(null);
  const [pending, setPending] = useState(false);

  const close = useCallback(() => {
    if (pending) return;
    setOptions(null);
  }, [pending]);

  const confirm = useCallback((nextOptions: ConfirmOptions) => {
    setOptions(nextOptions);
  }, []);

  const run = useCallback(() => {
    if (!options || pending) return;
    setPending(true);
    void Promise.resolve(options.run()).finally(() => {
      setPending(false);
      setOptions(null);
    });
  }, [options, pending]);

  const dialog = useMemo(
    () => <ConfirmDialog options={options} pending={pending} onCancel={close} onConfirm={run} />,
    [close, options, pending, run],
  );

  return { confirm, confirmDialog: dialog, confirmPending: pending };
}
