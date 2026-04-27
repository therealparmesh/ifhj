import { adfToMd, mdToAdf } from "github-markdown-adf";

/**
 * ADF → plaintext for display. Prefers the round-trip through `adfToMd`
 * for doc nodes (it handles tables, task lists, all the modern marks);
 * falls back to a hand-written walker for partial/edge nodes.
 */
export function adfToText(node: any): string {
  if (!node) return "";
  if (typeof node === "string") return node;
  if (node.type === "doc" && node.version === 1) {
    try {
      return adfToMd(node).replaceAll("\t", "  ");
    } catch {}
  }
  // Tabs desync Ink's column math with terminal width — normalize to spaces.
  if (node.type === "text") return (node.text ?? "").replaceAll("\t", "  ");
  if (node.type === "hardBreak") return "\n";
  if (node.type === "mention") return `@${node.attrs?.text ?? node.attrs?.displayName ?? ""}`;
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

/**
 * Convert our in-editor mention syntax — `[@Display Name](jira-mention:<accountId>)` —
 * to ADF mention nodes. The link form is what the Neovim `completefunc`
 * inserts when the user picks someone from the `@` menu; anything else
 * stays as literal text.
 *
 * We rewrite those markdown links to a unique per-call sentinel token,
 * then hand `mdToAdf` a resolver that only recognizes those sentinels.
 * That keeps plain `@foo` in prose from being mistakenly promoted — the
 * user's intent is carried by the link syntax, not by guessing.
 */
export function textToAdf(text: string): any {
  const cleaned = text.replaceAll(/\r\n/g, "\n");
  const ids: string[] = [];
  const names: string[] = [];
  // Alphanumeric seed so the sentinel survives mdToAdf's mention regex,
  // which requires [A-Za-z0-9] as the first char of a handle.
  const seed = `ifhjm${Date.now().toString(36)}z`;
  const replaced = cleaned.replaceAll(/\[@([^\]]+)\]\(jira-mention:([^)]+)\)/g, (_m, name, id) => {
    const i = ids.push(id) - 1;
    names.push(name);
    return `@${seed}${i}`;
  });
  if (ids.length === 0) return mdToAdf(replaced);
  return mdToAdf(replaced, {
    mentions: (handle) => {
      if (!handle.startsWith(seed)) return null;
      const i = Number(handle.slice(seed.length));
      const id = ids[i];
      const name = names[i];
      if (!id) return null;
      return { id, text: `@${name}` };
    },
  });
}
