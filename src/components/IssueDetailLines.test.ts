import { describe, expect, test } from "bun:test";

import type { IssueDetail } from "../jira";
import { renderDetailLines } from "./IssueDetailLines";

function detail(description: string): IssueDetail {
  return {
    key: "PROJ-1",
    id: 1,
    summary: "Summary",
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
});
