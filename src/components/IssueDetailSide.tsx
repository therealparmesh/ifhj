import { Box, Text } from "ink";
import { useState } from "react";

import { theme } from "../ui";
import { Hint } from "./Hint";
import { TextInput } from "./TextInput";

/**
 * Inline text input for the three baked fields that edit this way:
 * title, points, due. Caller routes the submit by `field`.
 */
export function InlineFieldInput({
  field,
  initial,
  onCancel,
  onSubmit,
}: {
  field: string;
  initial: string;
  onCancel: () => void;
  onSubmit: (value: string) => void;
}) {
  const [value, setValue] = useState(initial);
  const placeholder =
    field === "title"
      ? "issue title"
      : field === "points"
        ? "enter a number (empty to clear)"
        : "YYYY-MM-DD (empty to clear)";
  return (
    <Box flexDirection="column" padding={2} borderStyle="round" borderColor={theme.accent}>
      <Text color={theme.accent} bold>
        {field}
      </Text>
      <Box marginTop={1}>
        <Text color={theme.muted}>› </Text>
        <TextInput
          value={value}
          placeholder={placeholder}
          onChange={setValue}
          onSubmit={() => onSubmit(value)}
          onCancel={onCancel}
        />
      </Box>
      <Box marginTop={1}>
        <Hint k="⏎" label="save" />
        <Hint k="esc" label="cancel" />
      </Box>
    </Box>
  );
}
