import { adfToMd, mdToAdf } from "github-markdown-adf";

const MENTION_HREF = "jira-mention:";
const CONTEXT_SECRET = {};
const ALLOWED_NODE_TYPES = new Set([
  "doc",
  "paragraph",
  "heading",
  "text",
  "hardBreak",
  "mention",
  "codeBlock",
  "rule",
  "blockquote",
  "bulletList",
  "orderedList",
  "listItem",
  "table",
  "tableRow",
  "tableHeader",
  "tableCell",
]);
const ALLOWED_MARK_TYPES = new Set([
  "strong",
  "em",
  "strike",
  "code",
  "underline",
  "subsup",
  "link",
]);

export class UnsupportedAdfEditError extends Error {
  override name = "UnsupportedAdfEditError";
}

export class AdfEditContext {
  readonly #source: any;
  readonly #baseline: any;

  constructor(secret: object, source: any, baseline: any) {
    if (secret !== CONTEXT_SECRET)
      throw new Error("ADF edit contexts can only be prepared by ifhj");
    this.#source = structuredClone(source);
    this.#baseline = structuredClone(baseline);
    Object.freeze(this);
  }

  convert(text: string): any {
    const edited = parseMarkdown(text);
    assertRepresentable(edited);
    return restoreByIdentity(this.#source, this.#baseline, edited);
  }
}

export type PreparedAdfEdit = { readonly text: string; readonly context: AdfEditContext };

/** Convert ADF to display Markdown. Complex table cells remain fully visible. */
export function adfToText(node: any): string {
  if (!node) return "";
  if (typeof node === "string") return node;
  if (node.type === "doc" && node.version === 1) {
    try {
      return displayMarkdown(node).replaceAll(/\r\n?/g, "\n").replaceAll("\t", "  ");
    } catch {
      return (node.content ?? []).map(adfToText).join("\n");
    }
  }
  // Partial nodes are display-only. Tabs desync Ink's terminal width math.
  if (node.type === "text")
    return String(node.text ?? "")
      .replaceAll(/\r\n?/g, "\n")
      .replaceAll("\t", "  ");
  if (node.type === "hardBreak") return "\n";
  if (node.type === "mention") return mentionText(node);
  if (node.type === "emoji") return node.attrs?.text ?? node.attrs?.shortName ?? "";
  if (node.type === "inlineCard") return node.attrs?.url ?? "";
  if (node.type === "media" || node.type === "mediaSingle" || node.type === "mediaGroup")
    return "[media]\n";
  if (node.type === "rule") return "\n───\n";
  if (node.type === "table") return displayTable(node) + "\n";
  if (node.type === "codeBlock") {
    const body = Array.isArray(node.content) ? node.content.map(adfToText).join("") : "";
    const language = typeof node.attrs?.language === "string" ? node.attrs.language : "";
    return `\n${markdownCodeBlock(body, language.includes("`") ? "" : language)}\n`;
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

/** Prepare existing ADF for editing without exposing source metadata in Markdown. */
export function prepareAdfEdit(sourceAdf: unknown): PreparedAdfEdit {
  const source = normalizeSource(sourceAdf);
  assertRepresentable(source);
  const text = editableMarkdown(source);
  const baseline = parseMarkdown(text);
  if (!same(projectNode(source), projectNode(baseline))) {
    throw new UnsupportedAdfEditError(
      "This Jira text uses formatting that cannot be edited safely in the terminal.",
    );
  }
  assertUnambiguousSource(source, baseline);
  return {
    text,
    context: new AdfEditContext(CONTEXT_SECRET, source, baseline),
  };
}

/** Convert a change made from prepareAdfEdit, retaining unchanged source nodes exactly. */
export function editedTextToAdf(text: string, context: AdfEditContext): any {
  if (!(context instanceof AdfEditContext)) {
    throw new Error("Invalid ADF edit context");
  }
  return context.convert(text);
}

/** Convert new user-authored Markdown. Existing Jira documents use editedTextToAdf. */
export function textToAdf(text: string): any {
  return parseMarkdown(text);
}

function parseMarkdown(text: string): any {
  return convertMentionLinks(mdToAdf(text.replaceAll(/\r\n/g, "\n")));
}

function normalizeSource(source: unknown): any {
  if (source === null || source === undefined) return { type: "doc", version: 1, content: [] };
  if (typeof source === "string") {
    return {
      type: "doc",
      version: 1,
      content: source ? [{ type: "paragraph", content: [{ type: "text", text: source }] }] : [],
    };
  }
  if (
    typeof source !== "object" ||
    Array.isArray(source) ||
    (source as any).type !== "doc" ||
    (source as any).version !== 1 ||
    !Array.isArray((source as any).content)
  ) {
    throw new UnsupportedAdfEditError("Jira returned an unsupported text document.");
  }
  return structuredClone(source);
}

function editableMarkdown(source: any): string {
  return replaceTokens(source, "IFHJ", (token) => adfToMd(prepareNode(source, token)));
}

function prepareNode(node: any, token: (replacement: string) => string): any {
  if (node?.type === "mention") {
    const id = String(node.attrs?.id ?? "");
    return {
      type: "text",
      text: mentionText(node).replaceAll("&", "&amp;"),
      marks: [{ type: "link", attrs: { href: MENTION_HREF + encodeURIComponent(id) } }],
    };
  }
  if (node?.type === "text" && typeof node.text === "string") {
    if (node.marks?.some((mark: any) => mark?.type === "code")) {
      const link = node.marks.find((mark: any) => mark?.type === "link");
      return {
        type: "text",
        text: token(markdownCodeSpan(node.text)),
        ...(link ? { marks: [link] } : {}),
      };
    }
    return { ...node, text: node.text.replaceAll("&", "&amp;") };
  }
  if (node?.type === "codeBlock") {
    const body = (node.content ?? []).map((child: any) => String(child?.text ?? "")).join("");
    return {
      type: "paragraph",
      content: [{ type: "text", text: token(markdownCodeBlock(body, node.attrs?.language)) }],
    };
  }
  if (!Array.isArray(node?.content)) return node;
  return {
    ...node,
    content: node.content.map((child: any) => prepareNode(child, token)),
  };
}

function assertRepresentable(node: any, parent = ""): void {
  if (!node || typeof node !== "object" || !ALLOWED_NODE_TYPES.has(node.type)) {
    throw unsupported(`the ${String(node?.type ?? "unknown")} format`);
  }
  if (node.type === "doc") assertOnlyAttrs(node, []);
  if (node.type === "codeBlock" && parent !== "doc") throw unsupported("nested code blocks");
  if (node.type === "table") {
    const rows = Array.isArray(node.content) ? node.content : [];
    if (
      rows.length === 0 ||
      !rows[0]?.content?.every((cell: any) => cell?.type === "tableHeader")
    ) {
      throw unsupported("tables without an explicit header row");
    }
  }
  if (node.type === "tableCell" || node.type === "tableHeader") {
    if (node.content?.length !== 1 || node.content[0]?.type !== "paragraph") {
      throw unsupported("table cells with multiple or non-paragraph blocks");
    }
    assertOnlyAttrs(node, []);
  }
  if (node.type === "table") assertOnlyAttrs(node, []);
  if (node.type === "tableRow") assertOnlyAttrs(node, []);
  if (node.type === "paragraph") assertOnlyAttrs(node, ["localId"]);
  if (node.type === "heading") assertOnlyAttrs(node, ["level", "localId"]);
  if (node.type === "codeBlock") assertOnlyAttrs(node, ["language", "localId", "uniqueId"]);
  if (node.type === "rule") assertOnlyAttrs(node, ["localId"]);
  if (node.type === "blockquote") assertOnlyAttrs(node, ["localId"]);
  if (node.type === "bulletList") assertOnlyAttrs(node, ["localId"]);
  if (node.type === "orderedList") assertOnlyAttrs(node, ["order", "localId"]);
  if (node.type === "listItem") assertOnlyAttrs(node, ["localId"]);
  if (node.type === "hardBreak") assertOnlyAttrs(node, ["text"]);
  if (node.type === "mention") assertOnlyAttrs(node, ["id", "text"]);
  if (node.type === "text" && node.attrs !== undefined) {
    throw unsupported("text-node attributes");
  }
  if (node.type === "text") {
    if (node.marks?.some((mark: any) => !ALLOWED_MARK_TYPES.has(mark?.type))) {
      throw unsupported("text color or advanced text marks");
    }
    for (const mark of node.marks ?? []) {
      if (mark.type === "link") assertOnlyAttrs(mark, ["href", "title"]);
      else if (mark.type === "subsup") assertOnlyAttrs(mark, ["type"]);
      else if (mark.attrs !== undefined) throw unsupported(`${mark.type} mark attributes`);
    }
  }
  if (Array.isArray(node.content)) {
    for (const child of node.content) assertRepresentable(child, node.type);
  }
}

function assertOnlyAttrs(node: any, allowed: string[]): void {
  if (node.attrs === undefined) return;
  if (!node.attrs || typeof node.attrs !== "object" || Array.isArray(node.attrs)) {
    throw unsupported(`${node.type} attributes`);
  }
  const unexpected = Object.keys(node.attrs).filter((key) => !allowed.includes(key));
  if (unexpected.length > 0) throw unsupported(`${node.type} styling`);
}

function unsupported(feature: string): UnsupportedAdfEditError {
  return new UnsupportedAdfEditError(
    `This Jira text contains ${feature}, which cannot be edited safely in the terminal. Open the issue in a browser to edit it.`,
  );
}

function restoreByIdentity(source: any, baseline: any, edited: any): any {
  if (same(baseline, edited)) return structuredClone(source);
  const originals = new Map<string, EditNode[]>();
  const changes = new Map<string, EditNode[]>();
  indexEditNode(baseline, null, originals, source);
  const root = indexEditNode(edited, null, changes);

  // Exact larger matches claim their descendants first. An inserted table must
  // not take metadata from a header inside an unchanged original table.
  const groups = [...originals.entries()].toSorted((a, b) => b[1][0]!.size - a[1][0]!.size);
  for (const [key, candidates] of groups) {
    const available = candidates.filter((node) => !isClaimed(node));
    const targets = (changes.get(key) ?? []).filter((node) => !isClaimed(node));
    if (!available.length || !targets.length) continue;
    const original = available[0]!.original;
    const needsPreservation = available.some((node) => !same(node.original, node.value));
    if (
      needsPreservation &&
      (available.length !== targets.length ||
        available.some((node) => !same(node.original, original)))
    ) {
      throw new Error(
        "The edited document has ambiguous matching content; nothing was saved. Revise the draft or edit it in Jira.",
      );
    }
    for (const node of available) node.claimed = true;
    for (const node of targets) {
      node.claimed = true;
      node.original = original;
    }
  }

  for (const candidates of originals.values()) {
    for (const node of candidates) {
      if (
        node.value.type === "text" &&
        node.original.text !== node.value.text &&
        !isClaimed(node)
      ) {
        throw new UnsupportedAdfEditError(
          "These changes cannot preserve the original line endings. Nothing was saved. Revise the draft or edit it in Jira.",
        );
      }
    }
  }
  return restoreEditNode(root);
}

type EditNode = {
  value: any;
  original: any;
  parent: EditNode | null;
  children: EditNode[];
  size: number;
  claimed: boolean;
};

function indexEditNode(
  value: any,
  parent: EditNode | null,
  index: Map<string, EditNode[]>,
  original?: any,
): EditNode {
  const node: EditNode = { value, original, parent, children: [], size: 1, claimed: false };
  node.children = (value.content ?? []).map((child: any, childIndex: number) =>
    indexEditNode(child, node, index, original?.content?.[childIndex]),
  );
  node.size += node.children.reduce((size, child) => size + child.size, 0);
  const key = `${parent?.value.type ?? ""}\0${JSON.stringify(value)}`;
  const matches = index.get(key) ?? [];
  matches.push(node);
  index.set(key, matches);
  return node;
}

function isClaimed(node: EditNode): boolean {
  for (let current: EditNode | null = node; current; current = current.parent) {
    if (current.claimed) return true;
  }
  return false;
}

function restoreEditNode(node: EditNode): any {
  if (node.claimed) return structuredClone(node.original);
  return Array.isArray(node.value.content)
    ? { ...node.value, content: node.children.map(restoreEditNode) }
    : node.value;
}

function assertUnambiguousSource(source: any, baseline: any): void {
  if (!Array.isArray(source?.content) || !Array.isArray(baseline?.content)) return;
  for (let left = 0; left < baseline.content.length; left++) {
    for (let right = left + 1; right < baseline.content.length; right++) {
      if (
        same(baseline.content[left], baseline.content[right]) &&
        !same(source.content[left], source.content[right])
      ) {
        throw unsupported("repeated blocks with ambiguous source formatting");
      }
    }
    assertUnambiguousSource(source.content[left], baseline.content[left]);
  }
}

function projectNode(node: any): any {
  if (!node || typeof node !== "object") return node;
  const projected: any = { type: node.type };
  if (node.type === "doc") projected.version = 1;
  const attrs = projectAttrs(node.attrs);
  if (attrs !== undefined) projected.attrs = attrs;
  if (node.type === "text") {
    projected.text = String(node.text ?? "").replaceAll(/\r\n?/g, "\n");
    if (node.marks) projected.marks = node.marks.map(projectMark);
  } else if (node.type === "mention") {
    projected.attrs = { id: String(node.attrs?.id ?? ""), text: mentionText(node) };
  }
  if (Array.isArray(node.content)) projected.content = node.content.map(projectNode);
  return projected;
}

function projectAttrs(attrs: any): any {
  if (!attrs || typeof attrs !== "object" || Array.isArray(attrs)) return undefined;
  const projected = Object.fromEntries(
    Object.entries(attrs).filter(([key]) => key !== "localId" && key !== "uniqueId"),
  );
  return Object.keys(projected).length > 0 ? projected : undefined;
}

function projectMark(mark: any): any {
  const attrs = projectAttrs(mark?.attrs);
  return {
    type: mark?.type,
    ...(attrs !== undefined ? { attrs } : {}),
  };
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function markdownCodeSpan(text: string): string {
  const longest = Math.max(0, ...Array.from(text.matchAll(/`+/g), (match) => match[0].length));
  const fence = "`".repeat(longest + 1);
  const hasMeaningfulEdgeSpaces = text.startsWith(" ") && text.endsWith(" ") && text.trim() !== "";
  const pad = text.startsWith("`") || text.endsWith("`") || hasMeaningfulEdgeSpaces ? " " : "";
  return `${fence}${pad}${text}${pad}${fence}`;
}

function markdownCodeBlock(body: string, language: unknown): string {
  const longest = Math.max(2, ...Array.from(body.matchAll(/`+/g), (match) => match[0].length));
  const fence = "`".repeat(longest + 1);
  const lang = typeof language === "string" ? language.trim() : "";
  if (lang.includes("`")) throw unsupported("a code-block language containing backticks");
  return `${fence}${lang}\n${body}\n${fence}`;
}

function mentionText(node: any): string {
  const text = String(node.attrs?.text ?? node.attrs?.displayName ?? `@${node.attrs?.id ?? ""}`);
  return text.startsWith("@") ? text : `@${text}`;
}

function displayTable(table: any): string {
  return (table.content ?? [])
    .map((row: any) =>
      (row.content ?? [])
        .map((cell: any) =>
          (cell.content ?? [])
            .map((block: any) => adfToText({ type: "doc", version: 1, content: [block] }).trim())
            .filter(Boolean)
            .join(" / "),
        )
        .join(" | "),
    )
    .join("\n");
}

function displayMarkdown(source: any): string {
  return replaceTokens(source, "IFHJD", (token) => {
    const visit = (node: any): any => {
      if (node?.type === "table") {
        return {
          type: "paragraph",
          content: [{ type: "text", text: token(displayTable(node)) }],
        };
      }
      if (!Array.isArray(node?.content)) return node;
      return { ...node, content: node.content.map(visit) };
    };
    return adfToMd(prepareNode(visit(source), token)).replaceAll("&amp;", "&");
  });
}

function replaceTokens(
  source: any,
  prefixName: string,
  convert: (token: (replacement: string) => string) => string,
): string {
  const serialized = JSON.stringify(source);
  let prefix = `\uE000${prefixName}`;
  while (serialized.includes(prefix)) prefix = `\uE000${prefix}`;
  const replacements = new Map<string, string>();
  let index = 0;
  const token = (replacement: string) => {
    const key = `${prefix}${index++}\uE001`;
    replacements.set(key, replacement);
    return key;
  };
  let markdown = convert(token);
  for (const [key, replacement] of replacements) markdown = markdown.replaceAll(key, replacement);
  return markdown;
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
      const encoded = href.slice(MENTION_HREF.length);
      let id = encoded;
      try {
        id = decodeURIComponent(encoded);
      } catch {}
      return { type: "mention", attrs: { id, text: node.text } };
    }
  }
  if (!Array.isArray(node?.content)) return node;
  return { ...node, content: node.content.map(convertMentionLinks) };
}
