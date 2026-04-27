import type { IssueDetail } from "../jira";
import { theme, truncate } from "../ui";

type DetailLine = {
  text: string;
  color: string | undefined;
  bold?: boolean;
  commentIdx?: number | undefined;
  /** Flag lines inside fenced code blocks; render with a dim bg so they
   *  read as a block rather than prose. */
  codeBg?: boolean;
};

const pad2 = (n: number) => String(n).padStart(2, "0");

export function formatShortDate(iso: string | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/**
 * Flatten an IssueDetail into a list of display lines (description →
 * sub-tasks → linked issues → comments). Soft-wraps at `mainWidth` and
 * tags each line with its comment index so the detail modal can jump
 * between comments with `[` / `]`.
 */
export function renderDetailLines(detail: IssueDetail, mainWidth: number): DetailLine[] {
  const out: DetailLine[] = [];
  const push = (
    text: string,
    color: string | undefined = theme.fg,
    bold = false,
    commentIdx?: number,
  ) => out.push({ text, color, bold, commentIdx });
  const pushLine = (text: string, color: string | undefined = theme.fg, commentIdx?: number) => {
    if (text.length === 0) {
      push("", color, false, commentIdx);
      return;
    }
    for (let i = 0; i < text.length; i += mainWidth)
      push(text.slice(i, i + mainWidth), color, false, commentIdx);
  };
  const pushSection = (label: string) => {
    push("");
    push(label.toUpperCase(), theme.accent, true);
    push("─".repeat(Math.min(mainWidth, label.length + 6)), theme.divider);
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

  if (detail.links.length > 0) {
    pushSection(`linked issues (${detail.links.length})`);
    for (const l of detail.links)
      push(
        `${l.direction} ${l.key} · ${l.statusName} · ${truncate(l.summary, mainWidth - l.key.length - l.direction.length - 16)}`,
        theme.fgDim,
      );
  }

  pushSection(`comments (${detail.comments.length})`);
  if (detail.comments.length === 0) {
    push("no comments yet", theme.muted);
    return out;
  }
  detail.comments.forEach((c, i) => {
    if (i > 0) push("·".repeat(Math.min(mainWidth, 20)), theme.divider, false, i);
    push(c.author, theme.info, true, i);
    push(formatShortDate(c.created), theme.muted, false, i);
    for (const ln of (c.body || "").split(/\n/)) pushLine(` ${ln}`, theme.fg, i);
  });

  let inCode = false;
  for (const ln of out) {
    if (ln.text.trimStart().startsWith("```")) {
      inCode = !inCode;
      ln.codeBg = true;
    } else if (inCode) {
      ln.codeBg = true;
    }
  }

  return out;
}
