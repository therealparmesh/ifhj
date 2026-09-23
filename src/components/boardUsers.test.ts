import { expect, test } from "bun:test";

import type { JiraUser } from "../jira";
import { deferred } from "../test/utils";
import { createBoardUsersLoader } from "./boardUsers";

test("deduplicates one project without reusing it for a different project", async () => {
  const oldProject = deferred<JiraUser[]>();
  const newProject = deferred<JiraUser[]>();
  const calls: string[] = [];
  const load = createBoardUsersLoader((projectKey) => {
    calls.push(projectKey);
    return projectKey === "OLD" ? oldProject.promise : newProject.promise;
  });

  expect(await load("")).toEqual({ users: [] });
  const firstOld = load("OLD");
  const secondOld = load("OLD");
  const fresh = load("NEW");
  expect(firstOld).toBe(secondOld);
  expect(calls).toEqual(["OLD", "NEW"]);

  newProject.resolve([{ accountId: "new", displayName: "New User" }]);
  oldProject.resolve([{ accountId: "old", displayName: "Old User" }]);
  expect(await fresh).toEqual({ users: [{ accountId: "new", displayName: "New User" }] });
  expect(await load("NEW")).toEqual({
    users: [{ accountId: "new", displayName: "New User" }],
  });
});

test("retries a failed project request", async () => {
  let calls = 0;
  const load = createBoardUsersLoader(async () => {
    calls++;
    if (calls === 1) throw new Error("temporary");
    return [{ accountId: "ok", displayName: "Recovered" }];
  });

  expect(await load("PROJ")).toEqual({
    users: [],
    warning: "Mention suggestions could not load: temporary. Plain @text is not a Jira mention.",
  });
  expect(await load("PROJ")).toEqual({
    users: [{ accountId: "ok", displayName: "Recovered" }],
  });
  expect(calls).toBe(2);
});
