import { Box, Text } from "ink";
import { useState } from "react";

import { useDimensions } from "../hooks";
import { theme } from "../ui";
import { ErrorMessage } from "./ErrorMessage";
import { Hint } from "./Hint";
import { LoadingLine } from "./LoadingLine";
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
  validate,
  submitLabel = "save",
  busy = false,
  error,
  onChange,
  busyLabel = "Saving…",
}: {
  field: string;
  initial: string;
  placeholder?: string;
  onCancel: () => void;
  onSubmit: (value: string) => void;
  validate?: (value: string) => string | null;
  submitLabel?: string;
  busy?: boolean;
  error?: string | null | undefined;
  onChange?: (() => void) | undefined;
  busyLabel?: string;
}) {
  const { cols } = useDimensions();
  const [value, setValue] = useState(initial);
  const [validationError, setValidationError] = useState<string | null>(null);
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
          width={Math.max(1, cols - 8)}
          onChange={(next) => {
            setValue(next);
            setValidationError(null);
            onChange?.();
          }}
          onSubmit={(next) => {
            const nextError = validate?.(next) ?? null;
            setValidationError(nextError);
            if (!nextError) onSubmit(next);
          }}
          onCancel={onCancel}
          isActive={!busy}
        />
      </Box>
      {validationError || error ? (
        <ErrorMessage message={validationError ?? error!} width={Math.max(1, cols - 6)} />
      ) : null}
      {busy ? <LoadingLine label={busyLabel} /> : null}
      <Box marginTop={1}>
        {busy ? (
          <Text color={theme.muted}>Please wait for the save to finish.</Text>
        ) : (
          <>
            <Hint k="⏎" label={submitLabel} />
            <Hint k="esc" label="cancel" />
          </>
        )}
      </Box>
    </Box>
  );
}
