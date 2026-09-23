import { Box, Text } from "ink";

import { useDimensions } from "../hooks";
import { theme } from "../ui";
import { ErrorMessage } from "./ErrorMessage";

/**
 * Preparation screen shown before the external editor takes ownership of the TTY.
 */
export function NvimBanner({ warning }: { warning?: string | undefined } = {}) {
  const { cols } = useDimensions();
  return (
    <Box flexDirection="column" padding={2} borderStyle="round" borderColor={theme.accent}>
      <Text color={theme.accent} bold>
        Preparing editor…
      </Text>
      <Box marginTop={1}>
        <Text color={theme.muted}>
          {warning ? "Continuing without mention suggestions…" : "Checking editor and suggestions."}
        </Text>
      </Box>
      {warning ? <ErrorMessage message={warning} width={Math.max(1, cols - 6)} rows={2} /> : null}
    </Box>
  );
}
