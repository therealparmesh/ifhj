import { Box, Text, useInput } from "ink";

import { theme } from "../ui";

const HELP_BINDINGS: { keys: string; desc: string }[] = [
  { keys: "← →", desc: "move between columns" },
  { keys: "↑ ↓", desc: "move within column" },
  { keys: "⏎", desc: "card action menu (edit / move / transition)" },
  { keys: "v", desc: "view full issue details" },
  { keys: "m", desc: "move card to any column (picker)" },
  { keys: "< >", desc: "transition to prev / next column" },
  { keys: "e / E", desc: "edit summary / description in Neovim" },
  { keys: "c", desc: "create issue (title → desc → type → relationship → target)" },
  { keys: "o / O", desc: "open current card / board in browser" },
  { keys: "/", desc: "search" },
  { keys: "n / N", desc: "next / prev match" },
  { keys: "a / A", desc: "filter by assignee / clear filter" },
  { keys: "r", desc: "refresh" },
  { keys: "q", desc: "back to board picker" },
];

export function HelpModal({ onClose }: { onClose: () => void }) {
  /**
   * Specific close keys only — "any key closes" turns accidental ↑/↓/tab
   * presses into a dismissal.
   */
  useInput((input, key) => {
    if (key.escape || key.return || input === "q" || input === "?") onClose();
  });
  // Align the description column against the longest key label.
  const keyColWidth = Math.max(...HELP_BINDINGS.map((b) => b.keys.length));
  return (
    <Box flexDirection="column" padding={2} borderStyle="round" borderColor={theme.accent}>
      <Text color={theme.accent} bold>
        keybindings
      </Text>
      <Box marginTop={1} flexDirection="column">
        {HELP_BINDINGS.map((b) => (
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
