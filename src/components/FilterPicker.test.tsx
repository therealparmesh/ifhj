import { expect, test } from "bun:test";
import { PassThrough } from "node:stream";

import { render } from "ink";

import { createTerminal, waitFor } from "../test/utils";
import { FilterPicker } from "./FilterPicker";

test("local picker selects from the latest batched query", async () => {
  const terminal = createTerminal();
  const picked: string[] = [];
  const app = render(
    <FilterPicker
      title="fruit"
      items={[
        { id: "apple", label: "Apple" },
        { id: "banana", label: "Banana" },
      ]}
      onPick={(id) => picked.push(id)}
      onCancel={() => {}}
    />,
    {
      interactive: true,
      stdin: terminal.stdin as unknown as typeof process.stdin,
      stdout: terminal.stdout as unknown as typeof process.stdout,
      stderr: new PassThrough() as unknown as typeof process.stderr,
      exitOnCtrlC: false,
      patchConsole: false,
    },
  );

  await app.waitUntilRenderFlush();
  terminal.stdin.write("ban");
  terminal.stdin.emit("readable");
  terminal.stdin.write("\r");
  terminal.stdin.emit("readable");
  await waitFor(() => picked.length === 1, "filtered picker submission");
  expect(picked).toEqual(["banana"]);
  app.unmount();
});
