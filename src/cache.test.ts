import { describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";

import { isolatedEnv, makeTempDir, runScript } from "./test/utils";

const cacheUrl = new URL("./cache.ts", import.meta.url).href;

async function runCacheCase(name: string, body: string): Promise<unknown> {
  const home = await makeTempDir(`cache-${name}`);
  try {
    const { exitCode, stdout, stderr } = await runScript(
      `
        const cache = await import(${JSON.stringify(cacheUrl)});
        const config = {
          name: "Board",
          projectKey: "PROJ",
          columns: [{ name: "To Do", statusIds: ["1"] }],
        };
        const jiraConfig = (authHeader) => ({
          server: "https://jira.example.test",
          authHeader,
        });
        const issue = (id) => ({
          id,
          key: \`PROJ-\${id}\`,
          summary: \`Issue \${id}\`,
          description: "",
          statusId: "1",
          statusName: "To Do",
          statusCategory: "new",
          updated: "2026-01-01T00:00:00.000Z",
          issueType: "Task",
          labels: [],
        });
        ${body}
       `,
      isolatedEnv(home),
    );
    expect(exitCode, stderr).toBe(0);
    return JSON.parse(stdout);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

describe("board cache", () => {
  test("isolates data for different credentials on one server and board", async () => {
    const result = await runCacheCase(
      "credentials",
      `
        const alice = jiraConfig("Basic alice");
        const bob = jiraConfig("Basic bob");
        await cache.writeBoardCache(alice, 1, config, [issue(1)]);
        const bobBefore = await cache.readBoardCache(bob, 1);
        await cache.writeBoardCache(bob, 1, config, [issue(2)]);
        await cache.writeBoardCache(
          alice,
          2,
          { ...config, columns: [{ name: "Unlimited", statusIds: ["1"], max: 0 }] },
          [issue(3)],
        );
        const aliceAfter = await cache.readBoardCache(alice, 1);
        const bobAfter = await cache.readBoardCache(bob, 1);
        const zeroLimit = await cache.readBoardCache(alice, 2);
        console.log(JSON.stringify({
          bobBefore,
          aliceKey: aliceAfter.issues[0].key,
          bobKey: bobAfter.issues[0].key,
          zeroLimit: zeroLimit.config.columns[0].max,
        }));
      `,
    );
    expect(result).toEqual({
      bobBefore: null,
      aliceKey: "PROJ-1",
      bobKey: "PROJ-2",
      zeroLimit: 0,
    });
  });

  test("long server URLs use bounded distinct board and recent paths", async () => {
    const result = await runCacheCase(
      "long-paths",
      `
        const { readdir } = await import("node:fs/promises");
        const { join } = await import("node:path");
        const prefix = "shared-prefix-".repeat(30);
        const first = {
          server: "https://jira.example.test/" + prefix + "first",
          authHeader: "Basic long-path",
        };
        const second = {
          server: "https://jira.example.test/" + prefix + "second",
          authHeader: "Basic long-path",
        };
        await cache.writeBoardCache(first, 11, config, [issue(11)]);
        await cache.writeRecents(first, 11, [{ key: "PROJ-11", summary: "First" }]);
        await cache.writeBoardCache(second, 11, config, [issue(12)]);
        const files = await readdir(join(process.env.HOME, ".cache", "ifhj"));
        console.log(JSON.stringify({
          firstBoard: (await cache.readBoardCache(first, 11)).issues[0].key,
          firstRecents: (await cache.readRecents(first, 11))[0].key,
          secondBoard: (await cache.readBoardCache(second, 11)).issues[0].key,
          fileCount: files.length,
          uniqueFiles: new Set(files).size,
          longestName: Math.max(...files.map((file) => Buffer.byteLength(file))),
        }));
      `,
    );
    expect(result).toEqual({
      firstBoard: "PROJ-11",
      firstRecents: "PROJ-11",
      secondBoard: "PROJ-12",
      fileCount: 3,
      uniqueFiles: 3,
      longestName: 255,
    });
  });

  test("serializes concurrent writes so the latest invocation wins", async () => {
    const result = await runCacheCase(
      "write-race",
      `
        const cfg = jiraConfig("Basic race");
        const originalWrite = Bun.write;
        let releaseFirst;
        const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
        let markFirstStarted;
        const firstStarted = new Promise((resolve) => { markFirstStarted = resolve; });
        let writes = 0;
        Bun.write = async (...args) => {
          writes++;
          if (writes === 1) {
            markFirstStarted();
            await firstGate;
          }
          return originalWrite(...args);
        };
        try {
          const first = cache.writeBoardCache(cfg, 1, config, [issue(1)]);
          await firstStarted;
          const second = cache.writeBoardCache(cfg, 1, config, [issue(999)]);
          const writesBeforeRelease = writes;
          releaseFirst();
          await Promise.all([first, second]);
          const saved = await cache.readBoardCache(cfg, 1);
          console.log(JSON.stringify({
            keys: saved.issues.map((item) => item.key),
            writes,
            writesBeforeRelease,
          }));
        } finally {
          Bun.write = originalWrite;
        }
      `,
    );
    expect(result).toEqual({ keys: ["PROJ-999"], writes: 2, writesBeforeRelease: 1 });
  });

  test("rejects valid JSON with a corrupted payload shape", async () => {
    const result = await runCacheCase(
      "corruption",
      `
        const { readdir, writeFile } = await import("node:fs/promises");
        const { join } = await import("node:path");
        const cfg = jiraConfig("Basic corrupt");
        await cache.writeBoardCache(cfg, 1, config, [issue(1)]);
        const dir = join(process.env.HOME, ".cache", "ifhj");
        const file = (await readdir(dir)).find((name) => !name.includes("recents"));
        const path = join(dir, file);
        const payload = JSON.parse(await Bun.file(path).text());
        payload.issues[0].labels = "not-an-array";
        await writeFile(path, JSON.stringify(payload));
        const invalidShape = await cache.readBoardCache(cfg, 1);
        payload.issues[0].labels = [];
        payload.config.columns[0].max = -1;
        await writeFile(path, JSON.stringify(payload));
        const invalidLimit = await cache.readBoardCache(cfg, 1);
        payload.config.columns[0].max = 0;
        payload.config.estimationFieldId = 42;
        await writeFile(path, JSON.stringify(payload));
        const invalidEstimation = await cache.readBoardCache(cfg, 1);
        payload.config.estimationFieldId = "customfield_42";
        await writeFile(path, JSON.stringify(payload));
        const validEstimation = await cache.readBoardCache(cfg, 1);
        await writeFile(path, "{");
        const malformedJson = await cache.readBoardCache(cfg, 1);
        console.log(JSON.stringify({
          invalidShape,
          invalidLimit,
          invalidEstimation,
          validEstimation: validEstimation?.config.estimationFieldId,
          malformedJson,
        }));
      `,
    );
    expect(result).toEqual({
      invalidShape: null,
      invalidLimit: null,
      invalidEstimation: null,
      validEstimation: "customfield_42",
      malformedJson: null,
    });
  });

  test("missing and failed writes are non-fatal and a later write recovers", async () => {
    const result = await runCacheCase(
      "io-failure",
      `
        const { readdir } = await import("node:fs/promises");
        const { join } = await import("node:path");
        const cfg = jiraConfig("Basic io-failure");
        const missingBoard = await cache.readBoardCache(cfg, 1);
        const missingRecents = await cache.readRecents(cfg, 1);
        await cache.writeBoardCache(cfg, 1, config, [issue(0)]);
        const originalWrite = Bun.write;
        let fail = true;
        Bun.write = async (...args) => {
          if (fail) {
            fail = false;
            await originalWrite(args[0], String(args[1]).slice(0, 12));
            throw new Error("synthetic write failure");
          }
          return originalWrite(...args);
        };
        try {
          await cache.writeBoardCache(cfg, 1, config, [issue(1)]);
          const afterFailure = await cache.readBoardCache(cfg, 1);
          await cache.writeBoardCache(cfg, 1, config, [issue(2)]);
          const recovered = await cache.readBoardCache(cfg, 1);
          const files = await readdir(join(process.env.HOME, ".cache", "ifhj"));
          console.log(JSON.stringify({
            missingBoard,
            missingRecents,
            afterFailure: afterFailure.issues.map((item) => item.key),
            recovered: recovered.issues.map((item) => item.key),
            temporaryFiles: files.filter((file) => file.endsWith(".tmp")),
          }));
        } finally {
          Bun.write = originalWrite;
        }
      `,
    );
    expect(result).toEqual({
      missingBoard: null,
      missingRecents: [],
      afterFailure: ["PROJ-0"],
      recovered: ["PROJ-2"],
      temporaryFiles: [],
    });
  });

  test("readers keep the last complete value during a partial replacement", async () => {
    const result = await runCacheCase(
      "atomic-read",
      `
        const cfg = jiraConfig("Basic atomic-read");
        await cache.writeBoardCache(cfg, 1, config, [issue(1)]);
        const originalWrite = Bun.write;
        let release;
        const gate = new Promise((resolve) => { release = resolve; });
        let markPartial;
        const partial = new Promise((resolve) => { markPartial = resolve; });
        Bun.write = async (...args) => {
          await originalWrite(args[0], "{");
          markPartial();
          await gate;
          return originalWrite(...args);
        };
        try {
          const replacement = cache.writeBoardCache(cfg, 1, config, [issue(2)]);
          await partial;
          const whilePartial = await cache.readBoardCache(cfg, 1);
          release();
          await replacement;
          const afterReplace = await cache.readBoardCache(cfg, 1);
          console.log(JSON.stringify({
            whilePartial: whilePartial.issues.map((item) => item.key),
            afterReplace: afterReplace.issues.map((item) => item.key),
          }));
        } finally {
          Bun.write = originalWrite;
        }
      `,
    );
    expect(result).toEqual({ whilePartial: ["PROJ-1"], afterReplace: ["PROJ-2"] });
  });
});

describe("recent issue cache", () => {
  test("validates entries and isolates credentials", async () => {
    const result = await runCacheCase(
      "recents",
      `
        const alice = jiraConfig("Basic alice-recents");
        const bob = jiraConfig("Basic bob-recents");
        await cache.writeRecents(alice, 4, [{ key: "PROJ-1", summary: "One" }]);
        await cache.writeRecents(alice, 5, [{ key: "PROJ-2", summary: 2 }]);
        console.log(JSON.stringify({
          alice: await cache.readRecents(alice, 4),
          bob: await cache.readRecents(bob, 4),
          corrupt: await cache.readRecents(alice, 5),
        }));
      `,
    );
    expect(result).toEqual({
      alice: [{ key: "PROJ-1", summary: "One" }],
      bob: [],
      corrupt: [],
    });
  });
});
