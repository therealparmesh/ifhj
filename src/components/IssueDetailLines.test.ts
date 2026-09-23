import { describe, expect, test } from "bun:test";

import type { IssueDetail } from "../jira";
import { renderDetailLines } from "./IssueDetailLines";

function detail(description: string, summary = "Summary"): IssueDetail {
  return {
    key: "PROJ-1",
    id: 1,
    summary,
    description,
    statusId: "1",
    statusName: "Open",
    statusCategory: "new",
    updated: "2026-01-01T00:00:00.000Z",
    created: "2026-01-01T00:00:00.000Z",
    issueType: "Task",
    labels: [],
    components: [],
    fixVersions: [],
    subtasks: [],
    links: [],
    comments: [],
    customFields: [],
    editmeta: new Map(),
    rawFields: {},
  };
}

describe("renderDetailLines", () => {
  test("marks description code fences when an issue has no comments", () => {
    const lines = renderDetailLines(detail("```ts\nconst value = 1;\n```"), 40);
    const codeLines = lines.filter(
      (line) => line.text.includes("```") || line.text.includes("const"),
    );

    expect(codeLines).toHaveLength(3);
    expect(codeLines.every((line) => line.codeBg)).toBe(true);
  });

  test("wraps by terminal width without dropping wide characters", () => {
    const description = "界".repeat(12);
    const lines = renderDetailLines(detail(description), 10);
    const wrapped = lines.filter((line) => line.text.includes("界"));

    expect(wrapped.map((line) => line.text).join("")).toBe(description);
    expect(wrapped.every((line) => Bun.stringWidth(line.text) <= 10)).toBe(true);
  });

  test("adds only overflowing titles as plain wrapped body lines without changing comment tags", () => {
    const title = `Long wide 界 title with \`\`\` text and a recognizable TITLE-END`;
    const value = detail("Description stays plain", title);
    value.comments = [
      {
        id: "1",
        author: "Commenter",
        authorAccountId: "user-1",
        body: "Comment body",
        created: "2026-01-02T00:00:00.000Z",
      },
    ];
    const lines = renderDetailLines(value, 12, 20);
    const titleLines = lines.filter((line) => line.plainTitle);

    expect(lines.some((line) => line.text === "Full title")).toBe(true);
    expect(titleLines.map((line) => line.text).join("")).toBe(title);
    expect(titleLines.every((line) => !line.codeBg && Bun.stringWidth(line.text) <= 12)).toBe(true);
    const descriptionLine = lines.find((line) => line.text.startsWith("Description "));
    expect(descriptionLine).toBeDefined();
    expect(descriptionLine!.codeBg).toBeUndefined();
    const commentBodyLine = lines.find((line) => line.text.startsWith(" Comment"));
    expect(commentBodyLine).toBeDefined();
    expect(commentBodyLine!.commentIdx).toBe(0);

    const short = renderDetailLines(detail("Short description"), 40, 20);
    expect(short.some((line) => line.text === "Full title")).toBe(false);
  });
});
