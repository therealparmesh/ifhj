import { Box, Text } from "ink";
import { useMemo, useState } from "react";

import { useInput } from "../input";
import { graphemes } from "../text";
import { normalizeMessage, theme } from "../ui";

function takeCells(text: string, width: number): string {
  let used = 0;
  let end = 0;
  for (const { segment, index } of graphemes(text)) {
    const cells = Bun.stringWidth(segment);
    if (used + cells > width) break;
    used += cells;
    end = index + segment.length;
  }
  return text.slice(0, end);
}

function errorLines(message: string, width: number): string[] {
  const normalized = normalizeMessage(message);
  const limit = Math.max(1, width);
  if (!normalized) return ["Unknown error."];
  const lines: string[] = [];
  let rest = normalized;
  while (rest) {
    if (Bun.stringWidth(rest) <= limit) {
      lines.push(rest);
      break;
    }
    const candidate = takeCells(rest, limit);
    if (!candidate) {
      const first = graphemes(rest)[Symbol.iterator]().next().value?.segment ?? rest;
      lines.push(first);
      rest = rest.slice(first.length);
      continue;
    }
    const breakAt = candidate.lastIndexOf(" ");
    const line = breakAt > 0 ? candidate.slice(0, breakAt) : candidate;
    lines.push(line);
    rest = rest.slice(line.length).trimStart();
  }
  return lines;
}

export function errorMessageHeight(
  message: string,
  width: number,
  rows = 2,
  dismissible = false,
): number {
  const lineCount = errorLines(message, width).length;
  return Math.min(rows, lineCount) + (lineCount > rows || dismissible ? 1 : 0);
}

export function ErrorMessage({
  message,
  width,
  rows = 2,
  onDismiss,
}: {
  message: string;
  width: number;
  rows?: number;
  onDismiss?: (() => void) | undefined;
}) {
  const lines = useMemo(() => errorLines(message, width), [message, width]);
  const pageSize = Math.max(1, rows);
  const pages = Math.ceil(lines.length / pageSize);
  const [paging, setPaging] = useState({ message, page: 0 });
  const page = paging.message === message ? paging.page : 0;
  const safePage = Math.min(page, Math.max(0, pages - 1));
  useInput((input, key) => {
    if (onDismiss && key.ctrl && input.toLowerCase() === "g") {
      onDismiss();
      return;
    }
    if (pages > 1 && key.ctrl && input.toLowerCase() === "p") {
      setPaging({ message, page: (page + 1) % pages });
    }
  });
  const showHint = pages > 1 || Boolean(onDismiss);
  return (
    <Box flexDirection="column" width={width}>
      {lines.slice(safePage * pageSize, (safePage + 1) * pageSize).map((line, index) => (
        <Text key={`${safePage}-${index}`} color={theme.error} wrap="truncate">
          {line}
        </Text>
      ))}
      {showHint ? (
        <Text color={theme.muted} wrap="truncate">
          {pages > 1 ? `Ctrl+P error details · ${safePage + 1}/${pages}` : ""}
          {pages > 1 && onDismiss ? " · " : ""}
          {onDismiss ? "Ctrl+G dismiss" : ""}
        </Text>
      ) : null}
    </Box>
  );
}
