import { useInput as useInkInput } from "ink";
import { createContext, type ReactNode, useContext } from "react";

const InputEnabled = createContext(true);

/** Hidden screens retain their state but must not act on keyboard input. */
export function InputScope({ enabled, children }: { enabled: boolean; children: ReactNode }) {
  const parentEnabled = useContext(InputEnabled);
  return <InputEnabled.Provider value={parentEnabled && enabled}>{children}</InputEnabled.Provider>;
}

export function useInput(
  handler: Parameters<typeof useInkInput>[0],
  options: NonNullable<Parameters<typeof useInkInput>[1]> = {},
) {
  const enabled = useContext(InputEnabled);
  useInkInput(
    (input, key) => {
      if (enabled && options.isActive !== false) handler(input, key);
    },
    // Keep one parser subscription mounted so keys typed while a retained
    // screen is disabled are consumed now, not replayed when it becomes active.
    { ...options, isActive: true },
  );
}
