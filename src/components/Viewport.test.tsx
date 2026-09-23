import { expect, test } from "bun:test";
import { PassThrough } from "node:stream";

import { render, Text } from "ink";
import { useEffect, useState } from "react";

import { useInput } from "../input";
import { createTerminal, sendInput, waitFor } from "../test/utils";
import { Viewport } from "./Viewport";

function screen(columns: number, rows: number) {
  return (
    <Viewport columns={columns} rows={rows}>
      <Child />
    </Viewport>
  );
}

function Child() {
  const [count, setCount] = useState(0);
  useEffect(() => {
    mounts++;
  }, []);
  useInput((input) => {
    if (input === "x") setCount((value) => value + 1);
  });
  return <Text>draft {count}</Text>;
}

let mounts = 0;

test("small-terminal notice keeps child state mounted and input disabled", async () => {
  mounts = 0;
  const terminal = createTerminal(80, 24);
  const app = render(screen(80, 24), {
    interactive: true,
    stdin: terminal.stdin as unknown as typeof process.stdin,
    stdout: terminal.stdout as unknown as typeof process.stdout,
    stderr: new PassThrough() as unknown as typeof process.stderr,
    exitOnCtrlC: false,
    patchConsole: false,
  });
  try {
    await sendInput(app, terminal.stdin, "x");
    await waitFor(() => terminal.output().includes("draft 1"), "initial state");
    app.rerender(screen(40, 10));
    await waitFor(() => terminal.output().includes("Terminal too small"), "small notice");
    await sendInput(app, terminal.stdin, "x");
    terminal.clearOutput();
    app.rerender(screen(80, 24));
    await waitFor(() => terminal.output().includes("draft 1"), "restored state");
    expect(terminal.output()).not.toContain("draft 2");
    expect(mounts).toBe(1);
  } finally {
    app.unmount();
  }
});

test("Ctrl+C exits while the minimum-size notice is active", async () => {
  const terminal = createTerminal(40, 10);
  const app = render(screen(40, 10), {
    interactive: true,
    stdin: terminal.stdin as unknown as typeof process.stdin,
    stdout: terminal.stdout as unknown as typeof process.stdout,
    stderr: new PassThrough() as unknown as typeof process.stderr,
    exitOnCtrlC: true,
    patchConsole: false,
  });
  try {
    await app.waitUntilRenderFlush();
    terminal.stdin.write("\x03");
    await Promise.race([
      app.waitUntilExit(),
      Bun.sleep(1_000).then(() => {
        throw new Error("Ctrl+C did not exit the minimum-size screen");
      }),
    ]);
  } finally {
    app.unmount();
  }
});
