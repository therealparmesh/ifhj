import type { IssueDetail } from "../jira";
import { normalizeMessage, theme, truncate } from "../ui";

type DetailLine = {
  text: string;
  color: string | undefined;
  bold?: boolean;
  commentIdx?: number | undefined;
  /** Flag lines inside fenced code blocks; render with a dim bg so they
   *  read as a block rather than prose. */
  codeBg?: boolean;
  /** Title text is plain even when it contains Markdown fence characters. */
  plainTitle?: boolean;
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
export function renderDetailLines(
  detail: IssueDetail,
  mainWidth: number,
  compactTitleWidth = Number.POSITIVE_INFINITY,
): DetailLine[] {
  const out: DetailLine[] = [];
  const push = (
    text: string,
    color: string | undefined = theme.fg,
    bold = false,
    commentIdx?: number,
    plainTitle = false,
  ) => out.push({ text, color, bold, commentIdx, ...(plainTitle ? { plainTitle: true } : {}) });
  const pushLine = (
    text: string,
    color: string | undefined = theme.fg,
    commentIdx?: number,
    plainTitle = false,
  ) => {
    if (text.length === 0) {
      push("", color, false, commentIdx, plainTitle);
      return;
    }
    let line = "";
    let width = 0;
    for (const { segment } of new Intl.Segmenter().segment(text)) {
      const segmentWidth = Bun.stringWidth(segment);
      if (line && width + segmentWidth > mainWidth) {
        push(line, color, false, commentIdx, plainTitle);
        line = "";
        width = 0;
      }
      line += segment;
      width += segmentWidth;
    }
    if (line) push(line, color, false, commentIdx, plainTitle);
  };
  const pushSection = (label: string) => {
    push("");
    push(label, theme.accent, true);
    push("─".repeat(Math.min(mainWidth, label.length + 6)), theme.divider);
  };

  const title = normalizeMessage(detail.summary);
  if (Bun.stringWidth(title) > compactTitleWidth) {
    pushSection("Full title");
    pushLine(title, theme.fg, undefined, true);
  }

  pushSection("Description");
  for (const ln of (detail.description || "—").split(/\n/)) pushLine(ln);

  if (detail.subtasks.length > 0) {
    pushSection(`Sub-tasks (${detail.subtasks.length})`);
    for (const s of detail.subtasks)
      push(
        `${s.key} · ${s.statusName} · ${truncate(s.summary, mainWidth - s.key.length - 16)}`,
        theme.fgDim,
      );
  }

  if (detail.links.length > 0) {
    pushSection(`Linked issues (${detail.links.length})`);
    for (const l of detail.links)
      push(
        `${l.direction} ${l.key} · ${l.statusName} · ${truncate(l.summary, mainWidth - l.key.length - l.direction.length - 16)}`,
        theme.fgDim,
      );
  }

  pushSection(`Comments (${detail.comments.length})`);
  if (detail.comments.length === 0) {
    push("No comments yet.", theme.muted);
  }
  detail.comments.forEach((c, i) => {
    if (i > 0) push("·".repeat(Math.min(mainWidth, 20)), theme.divider, false, i);
    push(c.author, theme.info, true, i);
    push(formatShortDate(c.created), theme.muted, false, i);
    for (const ln of (c.body || "").split(/\n/)) pushLine(` ${ln}`, theme.fg, i);
  });

  // Code-fence scan runs across body lines only — section titles and
  // comment-author headers are rendered with their own bg behavior
  // (inverse when focused), so mixing codeBg in would compound awkwardly.
  let inCode = false;
  for (const ln of out) {
    if (ln.bold === true || ln.plainTitle) continue;
    if (ln.text.trimStart().startsWith("```")) {
      inCode = !inCode;
      ln.codeBg = true;
    } else if (inCode) {
      ln.codeBg = true;
    }
  }

  return out;
}
