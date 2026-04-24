import { Box, Text, useInput } from "ink";

import { theme } from "../ui";

const BOARD_BINDINGS: { keys: string; desc: string }[] = [
  { keys: "← → h l", desc: "move between columns" },
  { keys: "↑ ↓ j k", desc: "move within column" },
  { keys: "g / G", desc: "top / bottom of column" },
  { keys: "PgUp PgDn", desc: "page within column" },
  { keys: "⏎", desc: "card action menu (edit / move / transition)" },
  { keys: "v", desc: "view full issue details" },
  { keys: "t", desc: "transition to any status (fuzzy)" },
  { keys: "m", desc: "move card to any column (picker)" },
  { keys: "< >", desc: "transition to prev / next column" },
  { keys: "⌃, ⌃.", desc: "rerank card up / down within column" },
  { keys: "i", desc: "assign to me" },
  { keys: "e / E", desc: "edit summary / description in Neovim" },
  { keys: "c", desc: "create issue" },
  { keys: "y / Y", desc: "yank issue key / URL to clipboard" },
  { keys: "o / O", desc: "open current card / board in browser" },
  { keys: "/", desc: "search" },
  { keys: "n / N", desc: "next / prev match" },
  { keys: "f / F", desc: "filter menu / clear all filters" },
  { keys: "R", desc: "recent issues" },
  { keys: "J", desc: "JQL query view" },
  { keys: "r", desc: "refresh" },
  { keys: "q", desc: "back to board picker" },
];

const DETAIL_BINDINGS: { keys: string; desc: string }[] = [
  { keys: "tab", desc: "switch pane (body ↔ fields)" },
  { keys: "↑ ↓ j k", desc: "scroll body / move field cursor" },
  { keys: "g / G", desc: "top / bottom" },
  { keys: "⏎", desc: "edit focused field or open comment" },
  { keys: "x", desc: "clear focused field" },
  { keys: "[ ]", desc: "prev / next comment" },
  { keys: "c", desc: "add comment (Neovim)" },
  { keys: "C", desc: "create subtask" },
  { keys: "e / E", desc: "edit title / description (Neovim)" },
  { keys: "t", desc: "transition to status" },
  { keys: "m", desc: "move to column" },
  { keys: "w", desc: "toggle watch / unwatch" },
  { keys: "y / Y", desc: "yank issue key / URL" },
  { keys: "o", desc: "open in browser" },
  { keys: "esc / q", desc: "close" },
];

export function HelpModal({ onClose }: { onClose: () => void }) {
  /**
   * Specific close keys only — "any key closes" turns accidental ↑/↓/tab
   * presses into a dismissal.
   */
  useInput((input, key) => {
    if (key.escape || key.return || input === "q" || input === "?") onClose();
  });
  const allBindings = [...BOARD_BINDINGS, ...DETAIL_BINDINGS];
  const keyColWidth = Math.max(...allBindings.map((b) => b.keys.length));
  return (
    <Box flexDirection="column" padding={2} borderStyle="round" borderColor={theme.accent}>
      <Text color={theme.accent} bold>
        board
      </Text>
      <Box marginTop={1} flexDirection="column">
        {BOARD_BINDINGS.map((b) => (
          <Box key={b.keys}>
            <Text color={theme.pink}>{b.keys.padEnd(keyColWidth)}</Text>
            <Text color={theme.muted}> {b.desc}</Text>
          </Box>
        ))}
      </Box>
      <Box marginTop={1}>
        <Text color={theme.accent} bold>
          detail view
        </Text>
      </Box>
      <Box marginTop={1} flexDirection="column">
        {DETAIL_BINDINGS.map((b) => (
          <Box key={b.keys}>
            <Text color={theme.pink}>{b.keys.padEnd(keyColWidth)}</Text>
            <Text color={theme.muted}> {b.desc}</Text>
          </Box>
        ))}
      </Box>
      <Box marginTop={1}>
        <Text color={theme.muted}>esc / q / ? / ⏎ to close</Text>
      </Box>
    </Box>
  );
}
