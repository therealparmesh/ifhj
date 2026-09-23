import { describe, expect, test } from "bun:test";

import {
  UnsupportedAdfEditError,
  adfToText,
  editedTextToAdf,
  prepareAdfEdit,
  textToAdf,
} from "./adf";

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

describe("existing ADF edit context", () => {
  test("preserves source bytes, marks, entities, and mention identity after an unrelated edit", () => {
    const source = {
      type: "doc",
      version: 1,
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: " a_b ", marks: [{ type: "code" }] },
            { type: "text", text: " literal &copy; " },
            { type: "mention", attrs: { id: "id&fixture", text: "@A &copy; B" } },
          ],
        },
        {
          type: "codeBlock",
          attrs: { language: "markdown" },
          content: [{ type: "text", text: "\ta_b\r\n```\r\nafter" }],
        },
      ],
    };
    const prepared = prepareAdfEdit(source);
    expect(prepared.text).toContain("\ta_b\r\n```\r\n");
    expect(editedTextToAdf(`${prepared.text}\n\nUnrelated edit.`, prepared.context)).toEqual({
      ...source,
      content: [
        ...source.content,
        { type: "paragraph", content: [{ type: "text", text: "Unrelated edit." }] },
      ],
    });
    expect(() =>
      editedTextToAdf(prepared.text.replace("after", "changed"), prepared.context),
    ).toThrow("original line endings");
  });

  test("blocks non-reversible tables while display keeps every nested cell paragraph", () => {
    const table = {
      type: "table",
      content: [
        {
          type: "tableRow",
          content: [
            {
              type: "tableCell",
              content: [
                { type: "paragraph", content: [{ type: "text", text: "first" }] },
                { type: "paragraph", content: [{ type: "text", text: "second" }] },
              ],
            },
          ],
        },
      ],
    };
    const source = {
      type: "doc",
      version: 1,
      content: [
        { type: "panel", attrs: { panelType: "info" }, content: [table] },
        {
          type: "codeBlock",
          attrs: { language: "text`extra" },
          content: [{ type: "text", text: "code stays readable\r\nnext line" }],
        },
      ],
    };
    expect(adfToText(source)).toContain("first");
    expect(adfToText(source)).toContain("second");
    expect(adfToText(source)).toContain("code stays readable\nnext line");
    expect(() => prepareAdfEdit(source)).toThrow(UnsupportedAdfEditError);
  });

  test("does not interpret marker-looking code or reassign source nodes after insertion", () => {
    const marker = "<!-- ifhj-adf-table-v1:eyJyb3dzIjpbXX0 -->";
    expect(textToAdf(`\`\`\`text\n${marker}\n\`\`\``).content[0].content).toEqual([
      { type: "text", text: marker },
    ]);

    const source = {
      type: "doc",
      version: 1,
      content: [{ type: "paragraph", content: [{ type: "text", text: "original" }] }],
    };
    const prepared = prepareAdfEdit(source);
    const added = "| Added |\n| --- |\n| New cell |\n\n";
    const converted = editedTextToAdf(added + prepared.text, prepared.context);
    expect(JSON.stringify(converted).match(/original/g)).toHaveLength(1);
    expect(JSON.stringify(converted).match(/New cell/g)).toHaveLength(1);
  });

  test("retains unchanged table metadata without assigning it to inserted or edited cells", () => {
    const table = {
      type: "table",
      content: [
        {
          type: "tableRow",
          content: [
            tableCell("tableHeader", "Name", "header-name"),
            tableCell("tableHeader", "Note", "header-note"),
          ],
        },
        {
          type: "tableRow",
          content: [
            tableCell("tableCell", "First", "first"),
            tableCell("tableCell", "Keep me", "kept-paragraph"),
          ],
        },
        {
          type: "tableRow",
          content: [
            tableCell("tableCell", "Second", "second"),
            tableCell("tableCell", "Also kept", "also-kept"),
          ],
        },
      ],
    };
    const source = { type: "doc", version: 1, content: [table] };
    const prepared = prepareAdfEdit(source);
    const edited = editedTextToAdf(prepared.text.replace("First", "Changed"), prepared.context);
    expect(edited.content[0].content[1].content[1]).toEqual(table.content[1]!.content[1]);
    expect(edited.content[0].content[2]).toEqual(table.content[2]);
    expect(edited.content[0].content[1].content[0].content[0]).toEqual({
      type: "paragraph",
      content: [{ type: "text", text: "Changed" }],
    });

    const inserted = editedTextToAdf(
      `| Name | Note |\n| --- | --- |\n| New | Content |\n\n${prepared.text}`,
      prepared.context,
    );
    expect(inserted.content[1]).toEqual(table);
    expect(inserted.content[0].content[0].content[0].content[0].attrs).toBeUndefined();
    expect(() => editedTextToAdf(`${prepared.text}\n\n${prepared.text}`, prepared.context)).toThrow(
      "ambiguous matching content",
    );
  });

  test("restores exact blocks after no change, movement, deletion, and insertion", () => {
    const first = paragraph("First", "first");
    const second = paragraph("Second", "second");
    const source = { type: "doc", version: 1, content: [first, second] };
    const prepared = prepareAdfEdit(source);

    expect(editedTextToAdf(prepared.text, prepared.context)).toEqual(source);
    expect(editedTextToAdf("Second\n\nFirst", prepared.context).content).toEqual([second, first]);
    expect(editedTextToAdf("Second", prepared.context).content).toEqual([second]);
    expect(editedTextToAdf("New\n\nSecond", prepared.context).content).toEqual([
      { type: "paragraph", content: [{ type: "text", text: "New" }] },
      second,
    ]);
  });
});

function paragraph(text: string, localId: string) {
  return { type: "paragraph", attrs: { localId }, content: [{ type: "text", text }] };
}

function tableCell(type: string, text: string, localId: string) {
  return {
    type,
    content: [paragraph(text, localId)],
  };
}

function findMentions(node: any): { id: string; text: string }[] {
  if (node?.type === "mention") return [node.attrs];
  return Array.isArray(node?.content) ? node.content.flatMap(findMentions) : [];
}
