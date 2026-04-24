import { Box, Text } from "ink";

import { theme } from "../ui";

// A single keybind hint pill: bright key, muted label.
export function Hint({ k, label }: { k: string; label: string }) {
  return (
    <Box marginRight={2}>
      <Text color={theme.accent} bold>
        {k}
      </Text>
      <Text color={theme.muted}> {label}</Text>
    </Box>
  );
}
