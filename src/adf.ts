import { adfToMd, mdToAdf } from "github-markdown-adf";

const MENTION_HREF = "jira-mention:";

/**
 * ADF → Markdown for display and editing. Prefers `adfToMd`
 * for doc nodes (it handles tables, task lists, all the modern marks);
 * falls back to a hand-written walker for partial/edge nodes.
 */
export function adfToText(node: any): string {
  if (!node) return "";
  if (typeof node === "string") return node;
  if (node.type === "doc" && node.version === 1) {
    try {
      return adfToMd(preserveMentions(node)).replaceAll("\t", "  ");
    } catch {}
  }
  // Tabs desync Ink's column math with terminal width — normalize to spaces.
  if (node.type === "text") return (node.text ?? "").replaceAll("\t", "  ");
  if (node.type === "hardBreak") return "\n";
  if (node.type === "mention") return mentionText(node);
  if (node.type === "emoji") return node.attrs?.text ?? node.attrs?.shortName ?? "";
  if (node.type === "inlineCard") return node.attrs?.url ?? "";
  if (node.type === "media" || node.type === "mediaSingle" || node.type === "mediaGroup")
    return "[media]\n";
  if (node.type === "rule") return "\n───\n";
  if (node.type === "codeBlock") {
    const lang = node.attrs?.language ?? "";
    const body = Array.isArray(node.content) ? node.content.map(adfToText).join("") : "";
    return `\n\`\`\`${lang}\n${body}\n\`\`\`\n`;
  }
  const children = Array.isArray(node.content) ? node.content.map(adfToText).join("") : "";
  if (node.type === "listItem") return `• ${children.trim()}\n`;
  const block =
    node.type === "paragraph" ||
    node.type === "heading" ||
    node.type === "bulletList" ||
    node.type === "orderedList" ||
    node.type === "blockquote";
  return block ? children + "\n" : children;
}

function mentionText(node: any): string {
  const text = String(node.attrs?.text ?? node.attrs?.displayName ?? "");
  return text.startsWith("@") ? text : `@${text}`;
}

/** Convert mentions to marked text so the Markdown converter keeps their IDs. */
function preserveMentions(node: any): any {
  if (node?.type === "mention" && node.attrs?.id) {
    return {
      type: "text",
      text: mentionText(node),
      marks: [{ type: "link", attrs: { href: MENTION_HREF + node.attrs.id } }],
    };
  }
  if (!Array.isArray(node?.content)) return node;
  return { ...node, content: node.content.map(preserveMentions) };
}

/**
 * Convert our in-editor mention syntax — `[@Display Name](jira-mention:<accountId>)` —
 * to ADF mention nodes. The link form is what the Neovim `completefunc`
 * inserts when the user picks someone from the `@` menu; anything else
 * stays as literal text.
 *
 * Markdown is parsed first, then only explicit `jira-mention:` link nodes
 * become mentions. Code, escaped syntax, plain `@foo`, and ordinary links
 * remain unchanged because the Markdown parser does not expose them as
 * Jira-mention links.
 */
export function textToAdf(text: string): any {
  return convertMentionLinks(mdToAdf(text.replaceAll(/\r\n/g, "\n")));
}

function convertMentionLinks(node: any): any {
  if (node?.type === "text" && typeof node.text === "string" && node.text.startsWith("@")) {
    const link = Array.isArray(node.marks)
      ? node.marks.find((mark: any) => mark?.type === "link")
      : undefined;
    const href = link?.attrs?.href;
    if (
      typeof href === "string" &&
      href.startsWith(MENTION_HREF) &&
      href.length > MENTION_HREF.length
    ) {
      return { type: "mention", attrs: { id: href.slice(MENTION_HREF.length), text: node.text } };
    }
  }
  if (!Array.isArray(node?.content)) return node;
  return { ...node, content: node.content.map(convertMentionLinks) };
}
