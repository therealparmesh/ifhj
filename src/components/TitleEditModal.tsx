import { Box, Text } from "ink";
import { useRef } from "react";

import { useDimensions } from "../hooks";
import { theme } from "../ui";
import { ErrorMessage } from "./ErrorMessage";
import { Hint } from "./Hint";
import { LoadingLine } from "./LoadingLine";
import { TextInput } from "./TextInput";

type Props = {
  issueKey: string;
  value: string;
  onChange: (v: string) => void;
  onSubmit: (v: string) => void;
  onCancel: () => void;
  busy?: boolean | undefined;
  error?: string | null | undefined;
};

export function TitleEditModal({
  issueKey,
  value,
  onChange,
  onSubmit,
  onCancel,
  busy = false,
  error,
}: Props) {
  const { cols } = useDimensions();
  const submitLocked = useRef(false);
  const wasBusy = useRef(busy);
  if (wasBusy.current && !busy) submitLocked.current = false;
  wasBusy.current = busy;
  return (
    <Box flexDirection="column" padding={2} borderStyle="round" borderColor={theme.accent}>
      <Text color={theme.accent} bold>
        Edit title · {issueKey}
      </Text>
      <Box marginTop={1}>
        <Text color={theme.muted}>› </Text>
        <TextInput
          value={value}
          placeholder="Issue title"
          width={Math.max(1, cols - 8)}
          onChange={onChange}
          onSubmit={(next) => {
            if (submitLocked.current) return;
            if (next.trim()) submitLocked.current = true;
            onSubmit(next);
          }}
          onCancel={onCancel}
          isActive={!busy}
        />
      </Box>
      {busy ? <LoadingLine label="Saving title…" /> : null}
      {error ? <ErrorMessage message={error} width={Math.max(1, cols - 6)} /> : null}
      <Box marginTop={1}>
        {busy ? (
          <Text color={theme.muted}>Please wait for the save to finish.</Text>
        ) : (
          <>
            <Hint k="⏎" label="save" />
            <Hint k="esc" label="cancel" />
          </>
        )}
      </Box>
    </Box>
  );
}
