import { Box, Text, useInput } from "ink";
import { useState } from "react";

import { clamp, theme } from "../ui";
import { Hint } from "./Hint";

/**
 * Simple vertical picker for short, fixed lists. No filtering — see
 * FilterPicker for the searchable variant.
 */
export function ListPicker({
  title,
  items,
  onPick,
  onCancel,
}: {
  title: string;
  items: { id: string; label: string }[];
  onPick: (id: string) => void;
  onCancel: () => void;
}) {
  const [idx, setIdx] = useState(0);
  useInput((input, key) => {
    if (key.escape) return onCancel();
    if (key.upArrow || input === "k") setIdx((i) => clamp(i - 1, 0, items.length - 1));
    else if (key.downArrow || input === "j") setIdx((i) => clamp(i + 1, 0, items.length - 1));
    else if (key.return) {
      const it = items[idx];
      if (it) onPick(it.id);
    }
  });
  return (
    <Box flexDirection="column" padding={2} borderStyle="round" borderColor={theme.accent}>
      <Text color={theme.accent} bold>
        {title}
      </Text>
      <Box flexDirection="column" marginTop={1}>
        {items.map((it, i) => (
          <Box key={it.id}>
            <Text color={i === idx ? theme.accent : theme.muted}>{i === idx ? "> " : "  "}</Text>
            <Text color={i === idx ? theme.accent : theme.fgDim} bold={i === idx}>
              {it.label}
            </Text>
          </Box>
        ))}
      </Box>
      <Box marginTop={1}>
        <Hint k="↑↓" label="nav" />
        <Hint k="⏎" label="pick" />
        <Hint k="esc" label="cancel" />
      </Box>
    </Box>
  );
}
