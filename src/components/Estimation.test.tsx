import { expect, test } from "bun:test";
import { PassThrough } from "node:stream";

import { Box, render } from "ink";

import type { Issue } from "../jira";
import { createTerminal } from "../test/utils";
import { BoardHeader } from "./BoardHeader";
import { ColumnView } from "./Kanban";
import { SwimlaneHeader } from "./SwimlaneHeader";

function issue(key: string, estimate: number): Issue {
  return {
    id: Number(key.split("-")[1]),
    key,
    summary: "Estimate",
    description: "",
    statusId: "1",
    statusName: "To Do",
    statusCategory: "new",
    updated: "",
    issueType: "Task",
    labels: [],
    storyPoints: estimate,
  };
}

function headers(display: "points" | "time") {
  const terminal = createTerminal(120, 30);
  const app = render(
    <Box flexDirection="column">
      <BoardHeader
        boardName="Board"
        projectKey="PROJ"
        visibleIssueCount={1}
        totalIssueCount={1}
        visiblePointSum={display === "time" ? 3661 : 2.5}
        estimateDisplay={display}
        colIndex={0}
        colCount={1}
        filterCount={0}
        query=""
        matches={0}
        matchIdx={0}
      />
      <ColumnView
        column={{
          name: "Flat",
          statusIds: ["1"],
          issues: [issue("PROJ-1", display === "time" ? 60 : 3)],
        }}
        width={40}
        marginRight={0}
        isActive
        activeRow={0}
        scroll={0}
        cardsVisible={1}
        matchSet={new Set()}
        busyKeys={new Set()}
        colIdx={0}
        estimateDisplay={display}
      />
      <SwimlaneHeader
        columns={[
          { name: "Swim", statusIds: ["1"], issues: [issue("PROJ-2", display === "time" ? 1 : 4)] },
        ]}
        colWindowStart={0}
        visibleColCount={1}
        activeCol={0}
        width={40}
        estimateDisplay={display}
      />
    </Box>,
    {
      stdout: terminal.stdout as unknown as typeof process.stdout,
      stderr: new PassThrough() as unknown as typeof process.stderr,
      patchConsole: false,
    },
  );
  return { app, output: terminal.output };
}

test("time estimates keep hours, minutes, and seconds in every header", async () => {
  const view = headers("time");
  await view.app.waitUntilRenderFlush();
  expect(view.output()).toContain("1h 1m 1s");
  expect(view.output()).toContain("1m · 1");
  expect(view.output()).toContain("1s · 1");
  expect(view.output()).not.toContain("3661p");
  view.app.unmount();
});

test("custom numeric estimates preserve point formatting in every header", async () => {
  const view = headers("points");
  await view.app.waitUntilRenderFlush();
  expect(view.output()).toContain("2.5p");
  expect(view.output()).toContain("3p · 1");
  expect(view.output()).toContain("4p · 1");
  view.app.unmount();
});
