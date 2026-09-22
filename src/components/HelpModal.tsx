import { Box, Text, useInput } from "ink";
import { useState } from "react";

import { editorLabel } from "../editor";
import { useDimensions } from "../hooks";
import { clamp, theme } from "../ui";

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
  { keys: "x", desc: "clear optional field" },
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

const BINDINGS = [
  ...BOARD_BINDINGS.map((binding) => ({ ...binding, section: "board" as const })),
  ...DETAIL_BINDINGS.map((binding) => ({ ...binding, section: "detail view" as const })),
];

const KEY_COL_WIDTH = Math.max(...BINDINGS.map((binding) => Bun.stringWidth(binding.keys)));

export function HelpModal({ onClose }: { onClose: () => void }) {
  const { cols, rows } = useDimensions();
  const [scroll, setScroll] = useState(0);
  const innerWidth = Math.max(1, cols - 4);
  const descriptionWidth = Math.max(1, innerWidth - KEY_COL_WIDTH - 1);
  const displayRows = buildDisplayRows(descriptionWidth);
  // Border, sticky section header, and two footer lines consume five rows.
  const windowHeight = Math.max(1, rows - 5);
  const maxScroll = Math.max(0, displayRows.length - windowHeight);
  const offset = clamp(scroll, 0, maxScroll);
  const moveScroll = (delta: number) =>
    setScroll((current) => clamp(clamp(current, 0, maxScroll) + delta, 0, maxScroll));

  useInput((input, key) => {
    if (key.escape || key.return || input === "q" || input === "?") return onClose();
    if (key.home) return setScroll(0);
    if (key.end) return setScroll(maxScroll);
    if (key.pageUp) return moveScroll(-windowHeight);
    if (key.pageDown) return moveScroll(windowHeight);
    if (key.upArrow || input === "k") return moveScroll(-1);
    if (key.downArrow || input === "j") moveScroll(1);
  });

  const visible = displayRows.slice(offset, offset + windowHeight);
  const currentSection = visible[0]?.section ?? "board";

  return (
    <Box
      flexDirection="column"
      width={cols}
      height={rows}
      paddingX={1}
      borderStyle="round"
      borderColor={theme.accent}
    >
      <Box justifyContent="space-between">
        <Text color={theme.accent} bold wrap="truncate">
          help · {currentSection}
        </Text>
        <Text color={theme.muted}>
          {offset + 1}-{Math.min(offset + windowHeight, displayRows.length)}/{displayRows.length}
        </Text>
      </Box>
      <Box flexDirection="column" height={windowHeight}>
        {visible.map((row, index) =>
          row.kind === "section" ? (
            <Text key={`${offset + index}-section`} color={theme.accent} bold>
              {row.section}
            </Text>
          ) : (
            <Box key={`${offset + index}-binding`}>
              <Text color={theme.fgDim}>
                {row.keys}
                {" ".repeat(Math.max(0, KEY_COL_WIDTH - Bun.stringWidth(row.keys)))}
              </Text>
              <Text color={theme.muted}> {row.text}</Text>
            </Box>
          ),
        )}
      </Box>
      <Box flexDirection="column">
        <Text color={theme.muted} wrap="truncate">
          ↑↓/jk nav · PgUp/PgDn page
        </Text>
        <Text color={theme.muted} wrap="truncate">
          Home/End jump · esc/q/?/⏎ close
        </Text>
      </Box>
    </Box>
  );
}

type DisplayRow =
  | { kind: "section"; section: "detail view" }
  | { kind: "binding"; section: "board" | "detail view"; keys: string; text: string };

function buildDisplayRows(descriptionWidth: number): DisplayRow[] {
  const rows: DisplayRow[] = [];
  for (const binding of BINDINGS) {
    if (binding.section === "detail view" && rows.at(-1)?.section === "board") {
      rows.push({ kind: "section", section: "detail view" });
    }
    const lines = wrapText(binding.desc, descriptionWidth);
    lines.forEach((text, index) => {
      rows.push({
        kind: "binding",
        section: binding.section,
        keys: index === 0 ? binding.keys : "",
        text,
      });
    });
  }
  return rows;
}

function wrapText(text: string, width: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(" ")) {
    const next = line ? `${line} ${word}` : word;
    if (Bun.stringWidth(next) <= width) {
      line = next;
    } else {
      if (line) lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines;
}
