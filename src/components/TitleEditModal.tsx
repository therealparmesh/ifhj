import { Box, Text } from "ink";

import { theme } from "../ui";
import { Hint } from "./Hint";
import { TextInput } from "./TextInput";

type Props = {
  issueKey: string;
  value: string;
  onChange: (v: string) => void;
  onSubmit: (v: string) => void;
  onCancel: () => void;
};

export function TitleEditModal({ issueKey, value, onChange, onSubmit, onCancel }: Props) {
  return (
    <Box flexDirection="column" padding={2} borderStyle="round" borderColor={theme.accent}>
      <Text color={theme.accent} bold>
        edit title · {issueKey}
      </Text>
      <Box marginTop={1}>
        <Text color={theme.muted}>› </Text>
        <TextInput
          value={value}
          placeholder="issue title"
          onChange={onChange}
          onSubmit={onSubmit}
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
