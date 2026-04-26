import { Box, Text } from "ink";

import { theme } from "../ui";
import { Hint } from "./Hint";
import { TextInput } from "./TextInput";

type Props = {
  colName: string;
  typeName: string;
  value: string;
  onChange: (v: string) => void;
  onSubmit: (v: string) => void;
  onCancel: () => void;
};

export function QuickAddModal({ colName, typeName, value, onChange, onSubmit, onCancel }: Props) {
  return (
    <Box flexDirection="column" padding={2} borderStyle="round" borderColor={theme.accent}>
      <Text color={theme.accent} bold>
        quick add · {colName} · {typeName}
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
        <Hint k="⏎" label="create" />
        <Hint k="esc" label="cancel" />
      </Box>
    </Box>
  );
}
