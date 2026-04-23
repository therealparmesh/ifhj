import { Box, Text, useInput } from "ink";
import { useMemo, useState } from "react";

import { useDimensions } from "../hooks";
import type { IssueDetail } from "../jira";
import { theme, truncate, typeColors, typeGlyph } from "../ui";
import { Hint } from "./Hint";

const DETAIL_LABEL_WIDTH = 10;

const pad2 = (n: number) => String(n).padStart(2, "0");

function formatShortDate(iso: string | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

// A single body line in the detail modal's main column.
type DetailLine = { text: string; color: string; bold?: boolean };

/**
 * Flatten the detail document into renderable lines: description → sub-tasks
 * → comments. Each section gets a pink bold header and a thin divider.
 */
function renderDetailLines(detail: IssueDetail, mainWidth: number): DetailLine[] {
  const out: DetailLine[] = [];
  const push = (text: string, color = theme.fg, bold = false) => out.push({ text, color, bold });
  /**
   * Soft-wrap long lines so code, URLs, and stack traces aren't clipped at
   * the edge. One row per DetailLine keeps the scroll math honest.
   */
  const pushLine = (text: string, color = theme.fg) => {
    if (text.length === 0) {
      push("", color);
      return;
    }
    for (let i = 0; i < text.length; i += mainWidth) push(text.slice(i, i + mainWidth), color);
  };
  const pushSection = (label: string) => {
    push("");
    push(label.toUpperCase(), theme.pink, true);
    push("─".repeat(Math.min(mainWidth, label.length + 6)), theme.accentDim);
  };

  pushSection("description");
  for (const ln of (detail.description || "—").split(/\n/)) pushLine(ln);

  if (detail.subtasks.length > 0) {
    pushSection(`sub-tasks (${detail.subtasks.length})`);
    for (const s of detail.subtasks)
      push(
        `${s.key} · ${s.statusName} · ${truncate(s.summary, mainWidth - s.key.length - 16)}`,
        theme.fgDim,
      );
  }

  pushSection(`comments (${detail.comments.length})`);
  if (detail.comments.length === 0) {
    push("no comments yet", theme.muted);
    return out;
  }
  /**
   * Jira Cloud's /comment endpoint on Software boards returns a flat list —
   * threading isn't in the response shape. Render chronologically with an
   * author/date header per comment and a hair divider between entries.
   */
  detail.comments.forEach((c, i) => {
    if (i > 0) push("·".repeat(Math.min(mainWidth, 20)), theme.accentDim);
    push(c.author, theme.cyan, true);
    push(formatShortDate(c.created), theme.muted);
    for (const ln of (c.body || "").split(/\n/)) pushLine(` ${ln}`);
  });
  return out;
}

export function IssueDetailModal({
  issueKey,
  detail,
  error,
  onClose,
  onEditTitle,
  onEditDesc,
  onOpenWeb,
  onMove,
}: {
  issueKey: string;
  detail: IssueDetail | null;
  error: string | null;
  onClose: () => void;
  onEditTitle: () => void;
  onEditDesc: () => void;
  onOpenWeb: () => void;
  onMove: () => void;
}) {
  const { cols: termCols, rows: termRows } = useDimensions();
  const [scroll, setScroll] = useState(0);
  useInput((input, key) => {
    if (key.escape || input === "q" || (key.ctrl && input === "c")) return onClose();
    if (input === "e") return onEditTitle();
    if (input === "E") return onEditDesc();
    if (input === "o") return onOpenWeb();
    if (input === "m") return onMove();
    if (key.downArrow || input === "j") setScroll((s) => s + 1);
    else if (key.upArrow || input === "k") setScroll((s) => Math.max(0, s - 1));
    else if (key.pageDown) setScroll((s) => s + 10);
    else if (key.pageUp) setScroll((s) => Math.max(0, s - 10));
    else if (input === "g") setScroll(0);
    // `G` scrolls past the end; the render-time clamp pins to maxScroll.
    else if (input === "G") setScroll(Number.MAX_SAFE_INTEGER);
  });

  const innerHeight = Math.max(10, termRows - 4);
  const innerWidth = Math.max(60, termCols - 4);
  /**
   * Cap the side panel so the main column always gets at least 30 cols —
   * narrow terminals otherwise starve the body.
   */
  const sideWidth = Math.min(Math.max(26, Math.floor(innerWidth * 0.34)), innerWidth - 30);
  const mainWidth = innerWidth - sideWidth;

  /**
   * Memo before the early returns — hook order must stay stable across
   * loading → loaded transitions (Rules of Hooks).
   */
  const mainLines = useMemo(
    () => (detail ? renderDetailLines(detail, mainWidth) : []),
    [detail, mainWidth],
  );

  if (error) {
    return (
      <Box
        flexDirection="column"
        width={innerWidth + 2}
        height={innerHeight + 2}
        borderStyle="round"
        borderColor={theme.err}
        padding={1}
      >
        <Text color={theme.err} bold>
          failed to load {issueKey}
        </Text>
        <Box marginTop={1}>
          <Text color={theme.fg}>{error}</Text>
        </Box>
        <Box marginTop={1}>
          <Text color={theme.muted}>esc / q close</Text>
        </Box>
      </Box>
    );
  }

  if (!detail) {
    return (
      <Box
        flexDirection="column"
        width={innerWidth + 2}
        height={innerHeight + 2}
        borderStyle="round"
        borderColor={theme.accent}
        padding={1}
      >
        <Text color={theme.accent}>◴ loading {issueKey}…</Text>
      </Box>
    );
  }

  const typeColor = typeColors[detail.issueType] ?? theme.fg;
  const bodyHeight = innerHeight - 4; // minus header (3) + footer (1)
  const maxScroll = Math.max(0, mainLines.length - bodyHeight);
  const clampedScroll = Math.min(scroll, maxScroll);
  const visibleMain = mainLines.slice(clampedScroll, clampedScroll + bodyHeight);

  return (
    <Box
      flexDirection="column"
      width={innerWidth + 2}
      height={innerHeight + 2}
      borderStyle="round"
      borderColor={theme.accent}
    >
      {/* Header */}
      <Box paddingX={1}>
        <Text color={typeColor}>{typeGlyph(detail.issueType)} </Text>
        <Text color={theme.pink} bold>
          {detail.key}
        </Text>
        <Text color={theme.muted}> · </Text>
        <Text color={typeColor}>{detail.issueType}</Text>
        {detail.parentKey ? (
          <>
            <Text color={theme.muted}> · </Text>
            <Text color={theme.violet}>{detail.parentKey}</Text>
          </>
        ) : null}
      </Box>
      <Box paddingX={1}>
        <Text color={theme.fg} bold>
          {truncate(detail.summary, innerWidth - 4)}
        </Text>
      </Box>
      <Box paddingX={1}>
        <Text color={theme.accentDim}>{"─".repeat(Math.max(0, innerWidth))}</Text>
      </Box>

      {/* Body: main + side (side panel uses borderLeft as the divider) */}
      <Box flexDirection="row" flexGrow={1}>
        <Box flexDirection="column" width={mainWidth} paddingX={1}>
          {visibleMain.map((ln, i) => (
            <Text
              key={`${clampedScroll + i}`}
              color={ln.color}
              bold={ln.bold ?? false}
              wrap="truncate"
            >
              {ln.text || " "}
            </Text>
          ))}
        </Box>

        <Box
          flexDirection="column"
          width={sideWidth}
          paddingX={1}
          borderLeft
          borderTop={false}
          borderBottom={false}
          borderRight={false}
          borderStyle="single"
          borderColor={theme.accentDim}
        >
          <DetailField label="status" value={detail.statusName} color={theme.ok} />
          <DetailField label="assignee" value={detail.assignee ?? "Unassigned"} />
          <DetailField label="reporter" value={detail.reporter ?? "—"} />
          <DetailField label="priority" value={detail.priority ?? "—"} />
          <DetailField
            label="parent"
            value={detail.parentKey ?? detail.epicKey ?? "—"}
            color={theme.violet}
          />
          <DetailField label="sprint" value={detail.sprint ?? "—"} />
          <DetailField
            label="points"
            value={detail.storyPoints !== undefined ? String(detail.storyPoints) : "—"}
          />
          <DetailField
            label="labels"
            value={detail.labels.length === 0 ? "—" : detail.labels.join(", ")}
            color={theme.cyan}
          />
          <DetailField
            label="components"
            value={detail.components.length === 0 ? "—" : detail.components.join(", ")}
          />
          <DetailField
            label="fix vers"
            value={detail.fixVersions.length === 0 ? "—" : detail.fixVersions.join(", ")}
          />
          <DetailField label="due" value={detail.dueDate ?? "—"} color={theme.warn} />
          <DetailField label="created" value={formatShortDate(detail.created)} />
          <DetailField label="updated" value={formatShortDate(detail.updated)} />
        </Box>
      </Box>

      {/* Footer */}
      <Box paddingX={1}>
        <Text color={theme.accentDim}>{"─".repeat(Math.max(0, innerWidth))}</Text>
      </Box>
      <Box paddingX={1} justifyContent="space-between">
        <Box>
          <Hint k="↑↓" label="scroll" />
          <Hint k="g G" label="top / end" />
          <Hint k="e" label="title" />
          <Hint k="E" label="desc" />
          <Hint k="m" label="move" />
          <Hint k="o" label="web" />
          <Hint k="esc" label="close" />
        </Box>
        <Text color={theme.muted}>
          {clampedScroll + 1}-{Math.min(clampedScroll + bodyHeight, mainLines.length)} /{" "}
          {mainLines.length}
        </Text>
      </Box>
    </Box>
  );
}

function DetailField({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <Box>
      <Text color={theme.muted}>{label.padEnd(DETAIL_LABEL_WIDTH)} </Text>
      <Text color={color ?? theme.fg} wrap="truncate">
        {value}
      </Text>
    </Box>
  );
}
