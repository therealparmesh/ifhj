import { expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

import { isolatedEnv, makeTempDir, runScript } from "./test/utils";

const mentionUrl = new URL("./nvimMention.ts", import.meta.url).href;
const adfUrl = new URL("./adf.ts", import.meta.url).href;

test("actual completion payload preserves literal Markdown punctuation in mentions", async () => {
  const root = await makeTempDir("mention-payload");
  const temp = join(root, "tmp");
  await mkdir(temp);
  const names = [
    "A *Bold* B",
    "A `Dev` B",
    "A &copy; B",
    "A _Under_ B",
    "A [Ops] \\ B",
    "A (Lead) #1 + QA!",
  ];
  try {
    const source = `
      const { readdir } = await import("node:fs/promises");
      const { writeMentionAssets } = await import(${JSON.stringify(mentionUrl)});
      const { textToAdf } = await import(${JSON.stringify(adfUrl)});
      const names = ${JSON.stringify(names)};
      const assets = await writeMentionAssets(
        names.map((displayName, index) => ({ accountId: index === 0 ? "id&fixture" : "id-" + index, displayName })),
      );
      const payload = await Bun.file(assets.usersPath).json();
      const converted = payload.map((user) => {
        const markdown = "[@" + user.markdownName + "](jira-mention:" + user.markdownId + ")";
        return { markdown, content: textToAdf(markdown).content[0].content };
      });
      await assets.cleanup();
      let setupError;
      try {
        await writeMentionAssets([{
          accountId: "broken",
          get displayName() { throw new Error("bad user data"); },
        }]);
      } catch (error) {
        setupError = error.message;
      }
      console.log(JSON.stringify({
        converted,
        payloadHasRawId: payload.some((user) => "id" in user),
        setupError,
        remaining: await readdir(process.env.TMPDIR),
      }));
    `;
    const { exitCode, stdout, stderr } = await runScript(
      source,
      isolatedEnv(root, { TMPDIR: temp }),
    );
    expect(exitCode, stderr).toBe(0);
    const result = JSON.parse(stdout) as {
      converted: { markdown: string; content: unknown[] }[];
      payloadHasRawId: boolean;
      setupError: string;
      remaining: string[];
    };
    expect(result.converted.map(({ content }) => content)).toEqual(
      names.map((name, index) => [
        {
          type: "mention",
          attrs: { id: index === 0 ? "id&fixture" : `id-${index}`, text: `@${name}` },
        },
      ]),
    );
    expect(result.payloadHasRawId).toBe(false);
    expect(result.setupError).toBe("bad user data");
    expect(result.remaining).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
