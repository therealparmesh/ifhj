import { expect, test } from "bun:test";
import { PassThrough } from "node:stream";

import { render } from "ink";

import { createTerminal, waitFor } from "../test/utils";
import { InlineFieldInput } from "./IssueDetailSide";

test("inline field submits batched typing and Return with the latest value", async () => {
  const terminal = createTerminal();
  const submitted: string[] = [];
  const app = render(
    <InlineFieldInput
      field="Summary"
      initial=""
      onCancel={() => {}}
      onSubmit={(value) => submitted.push(value)}
    />,
    {
      stdin: terminal.stdin as unknown as typeof process.stdin,
      stdout: terminal.stdout as unknown as typeof process.stdout,
      stderr: new PassThrough() as unknown as typeof process.stderr,
      exitOnCtrlC: false,
      patchConsole: false,
    },
  );

  await app.waitUntilRenderFlush();
  terminal.stdin.write("batched summary");
  terminal.stdin.emit("readable");
  terminal.stdin.write("\r");
  terminal.stdin.emit("readable");
  await waitFor(() => submitted.length === 1, "inline field submission");
  expect(submitted).toEqual(["batched summary"]);
  app.unmount();
});
