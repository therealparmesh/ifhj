import { Box, Text, useInput } from "ink";

import { editorLabel } from "../editor";
import { theme } from "../ui";

// Resolved editor name ("Neovim" / "Vim") interpolated into the edit hints so
// help matches whatever's actually on $PATH.
const ED = editorLabel();

const BOARD_BINDINGS: { keys: string; desc: string }[] = [
  { keys: "← → h l", desc: "move between columns" },
  { keys: "↑ ↓ j k", desc: "move within column (spills across lanes in swim view)" },
  { keys: "g / G", desc: "top / bottom (first / last lane in swim view)" },
  { keys: "PgUp PgDn", desc: "page within column" },
  { keys: "⏎", desc: "card action menu (edit / move / transition)" },
  { keys: "v", desc: "view full issue details" },
  { keys: "t", desc: "transition to any status (fuzzy)" },
  { keys: "m", desc: "move card to any column (picker)" },
  { keys: "< >", desc: "move card to prev / next column" },
  { keys: "[ ]", desc: "rerank card up / down within column" },
  { keys: "i", desc: "assign to me" },
  { keys: "e", desc: "edit title (inline)" },
  { keys: "E", desc: `edit description (${ED})` },
  { keys: "c", desc: "create issue" },
  { keys: "a", desc: "quick add to current column" },
  { keys: "y / Y", desc: "yank issue key / URL to clipboard" },
  { keys: "o / O", desc: "open current card / board in browser" },
  { keys: "/", desc: "search" },
  { keys: "n / N", desc: "next / prev match" },
  { keys: "f / F", desc: "filter menu / clear all filters" },
  { keys: "s", desc: "toggle swimlane view (grouped lanes)" },
  { keys: "R", desc: "quick open — recents, or type to search all issues" },
  { keys: "J", desc: "JQL query view" },
  { keys: "r", desc: "refresh" },
  { keys: "q", desc: "back to board picker" },
];

const DETAIL_BINDINGS: { keys: string; desc: string }[] = [
  { keys: "tab", desc: "switch pane (body ↔ fields)" },
  { keys: "↑ ↓ j k", desc: "scroll body / move field cursor" },
  { keys: "g / G", desc: "top / bottom" },
  { keys: "PgUp PgDn", desc: "page scroll" },
  { keys: "⏎", desc: "edit focused field or open comment" },
  { keys: "x", desc: "clear focused field" },
  { keys: "[ ]", desc: "prev / next comment" },
  { keys: "c", desc: `add comment (${ED})` },
  { keys: "C", desc: "create subtask" },
  { keys: "e", desc: "edit title (inline)" },
  { keys: "E", desc: `edit description (${ED})` },
  { keys: "t", desc: "transition to status" },
  { keys: "m", desc: "move to column" },
  { keys: "w", desc: "toggle watch / unwatch" },
  { keys: "y / Y", desc: "yank issue key / URL" },
  { keys: "o", desc: "open in browser" },
  { keys: "r", desc: "refresh" },
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
            <Text color={theme.accent}>{b.keys.padEnd(keyColWidth)}</Text>
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
            <Text color={theme.accent}>{b.keys.padEnd(keyColWidth)}</Text>
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
