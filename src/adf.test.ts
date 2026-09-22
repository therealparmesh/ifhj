import { describe, expect, test } from "bun:test";

import { adfToText, textToAdf } from "./adf";

describe("ADF mention round trips", () => {
  test("preserves IDs and punctuation in visible names", () => {
    for (const text of ["@A ] Name", "@A_B", "@A * B", "@A \\ B"]) {
      const mention = { type: "mention", attrs: { id: "712020:account", text } };
      const original = {
        version: 1,
        type: "doc",
        content: [{ type: "paragraph", content: [mention] }],
      };
      expect(textToAdf(adfToText(original))).toEqual(original);
    }
  });

  test("converts adjacent and repeated links without consuming suffixes", () => {
    const adf = textToAdf(
      "[@A](jira-mention:id-a)-next [@B](jira-mention:id-b)word [@A](jira-mention:id-a)!",
    );
    expect(adf.content[0].content).toEqual([
      { type: "mention", attrs: { id: "id-a", text: "@A" } },
      { type: "text", text: "-next " },
      { type: "mention", attrs: { id: "id-b", text: "@B" } },
      { type: "text", text: "word " },
      { type: "mention", attrs: { id: "id-a", text: "@A" } },
      { type: "text", text: "!" },
    ]);
  });

  test("converts mention links inside lists and tables", () => {
    const adf = textToAdf(
      "- [@List User](jira-mention:list-id)\n\n| owner |\n| --- |\n| [@Table User](jira-mention:table-id) |",
    );
    expect(findMentions(adf)).toEqual([
      { id: "list-id", text: "@List User" },
      { id: "table-id", text: "@Table User" },
    ]);
  });

  test("keeps inline and fenced code literal", () => {
    const inline = textToAdf("`[@A](jira-mention:id)`");
    expect(inline.content[0].content).toEqual([
      { type: "text", text: "[@A](jira-mention:id)", marks: [{ type: "code" }] },
    ]);
    const fenced = textToAdf("```\n[@A](jira-mention:id)\n```");
    expect(fenced.content[0]).toEqual({
      type: "codeBlock",
      content: [{ type: "text", text: "[@A](jira-mention:id)" }],
    });
  });

  test("keeps ordinary links and escaped mention syntax as text or links", () => {
    const adf = textToAdf(
      String.raw`[ordinary](https://example.test) \[@A\]\(jira-mention:id\) [not a mention](jira-mention:id)`,
    );
    expect(findMentions(adf)).toEqual([]);
    expect(adf.content[0].content).toEqual([
      {
        type: "text",
        text: "ordinary",
        marks: [{ type: "link", attrs: { href: "https://example.test" } }],
      },
      { type: "text", text: " [@A](jira-mention:id) " },
      {
        type: "text",
        text: "not a mention",
        marks: [{ type: "link", attrs: { href: "jira-mention:id" } }],
      },
    ]);
  });

  test("keeps hand-written at-sign text literal", () => {
    const adf = textToAdf("Email person@example.test or ask @someone");
    const inline = adf.content[0].content;
    expect(inline.map((node: { text: string }) => node.text).join("")).toBe(
      "Email person@example.test or ask @someone",
    );
    expect(inline.some((node: { type: string }) => node.type === "mention")).toBe(false);
  });

  test("does not add a second at-sign in the partial-node fallback", () => {
    expect(adfToText({ type: "mention", attrs: { text: "@Already" } })).toBe("@Already");
  });
});

function findMentions(node: any): { id: string; text: string }[] {
  if (node?.type === "mention") return [node.attrs];
  return Array.isArray(node?.content) ? node.content.flatMap(findMentions) : [];
}
