import { Box, Text } from "ink";

import { editorLabel } from "../editor";
import { theme } from "../ui";

/**
 * Placeholder shown while the editor (Neovim or Vim) owns the TTY — editing a
 * title, description, or comment. The editor renders over the whole terminal,
 * so this is only what's behind it on the brief transitions in and out.
 */
export function NvimBanner() {
  return (
    <Box flexDirection="column" padding={2} borderStyle="round" borderColor={theme.accent}>
      <Text color={theme.accent} bold>
        editing in {editorLabel()}
      </Text>
      <Box marginTop={1}>
        <Text color={theme.muted}>save & quit to return</Text>
      </Box>
    </Box>
  );
}
