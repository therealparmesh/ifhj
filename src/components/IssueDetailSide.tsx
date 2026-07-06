import { Box, Text } from "ink";
import { useState } from "react";

import { theme } from "../ui";
import { Hint } from "./Hint";
import { TextInput } from "./TextInput";

/**
 * Inline text input for fields edited as free text: the issue title, plus
 * any text / number / date / label field routed here by `FieldEditor`.
 * `field` is the display label; the caller owns validation on submit and
 * supplies a kind-appropriate `placeholder` (it knows the field's type; we
 * can't infer it from the label).
 */
export function InlineFieldInput({
  field,
  initial,
  placeholder = "issue title",
  onCancel,
  onSubmit,
}: {
  field: string;
  initial: string;
  placeholder?: string;
  onCancel: () => void;
  onSubmit: (value: string) => void;
}) {
  const [value, setValue] = useState(initial);
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
