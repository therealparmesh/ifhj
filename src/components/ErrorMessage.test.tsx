import { expect, test } from "bun:test";
import { PassThrough } from "node:stream";

import { Box, render, Text } from "ink";

import { createTerminal, sendInput, waitFor } from "../test/utils";
import { ErrorMessage, errorMessageHeight } from "./ErrorMessage";

function oneLineError(message: string) {
  return <ErrorMessage message={message} width={12} rows={1} />;
}

test("bounded errors page through full wrapped and unbroken reasons", async () => {
  for (const [columns, rows] of [
    [80, 24],
    [120, 40],
  ] as const) {
    const width = columns - 6;
    const reason = `First line\n${"unbroken".repeat(30)} final words END_MARKER`;
    const terminal = createTerminal(columns, rows);
    const app = render(
      <Box flexDirection="column" width={columns}>
        <ErrorMessage message={reason} width={width} rows={2} />
        <Text>r retry · esc cancel</Text>
      </Box>,
      {
        interactive: true,
        stdin: terminal.stdin as unknown as typeof process.stdin,
        stdout: terminal.stdout as unknown as typeof process.stdout,
        stderr: new PassThrough() as unknown as typeof process.stderr,
        exitOnCtrlC: false,
        patchConsole: false,
      },
    );
    try {
      expect(Bun.stripANSI(terminal.output()).split("\n").length).toBeLessThanOrEqual(rows);
      expect(terminal.output()).toContain("r retry · esc cancel");
      const pageCount = Bun.stripANSI(terminal.output()).match(/Ctrl\+P error details · 1\/(\d+)/);
      expect(pageCount).not.toBeNull();
      const pages = Number(pageCount![1]);
      for (let page = 1; page < pages; page++) await sendInput(app, terminal.stdin, "\x10");
      await waitFor(() => terminal.output().includes("END_MARKER"), "last error page");
      expect(
        Math.max(
          ...Bun.stripANSI(terminal.output())
            .split("\n")
            .map((line) => Bun.stringWidth(line)),
        ),
      ).toBeLessThanOrEqual(columns);
    } finally {
      app.unmount();
    }
  }
});

test("normalizes line breaks and advances through wide graphemes at a one-cell width", async () => {
  const terminal = createTerminal(80, 24);
  const app = render(<ErrorMessage message={"line one\nline two"} width={20} rows={2} />, {
    interactive: true,
    stdin: terminal.stdin as unknown as typeof process.stdin,
    stdout: terminal.stdout as unknown as typeof process.stdout,
    stderr: new PassThrough() as unknown as typeof process.stderr,
    exitOnCtrlC: false,
    patchConsole: false,
  });
  try {
    await app.waitUntilRenderFlush();
    expect(Bun.stripANSI(terminal.output())).toBe("line one line two\n");
    terminal.clearOutput();
    app.rerender(<ErrorMessage message="界" width={2} rows={2} />);
    await app.waitUntilRenderFlush();
    expect(Bun.stripANSI(terminal.output())).toBe("界\n");
    terminal.clearOutput();
    app.rerender(<ErrorMessage message="界" width={1} rows={2} />);
    await app.waitUntilRenderFlush();
    expect(Bun.stripANSI(terminal.output())).toBe("…\n");
    terminal.clearOutput();
    app.rerender(<ErrorMessage message="界a" width={1} rows={2} />);
    await app.waitUntilRenderFlush();
    expect(Bun.stripANSI(terminal.output())).toBe("…\na\n");
  } finally {
    app.unmount();
  }
});

test("a new error reason resets to its first page", async () => {
  const terminal = createTerminal(80, 24);
  const app = render(oneLineError("FIRST_PAGE old middle OLD_END"), {
    interactive: true,
    stdin: terminal.stdin as unknown as typeof process.stdin,
    stdout: terminal.stdout as unknown as typeof process.stdout,
    stderr: new PassThrough() as unknown as typeof process.stderr,
    exitOnCtrlC: false,
    patchConsole: false,
  });
  try {
    await sendInput(app, terminal.stdin, "\x10");
    terminal.clearOutput();
    app.rerender(oneLineError("NEW_FIRST new middle NEW_END"));
    await waitFor(() => terminal.output().includes("NEW_FIRST"), "new first error page");
    expect(terminal.output()).not.toContain("NEW_END");
  } finally {
    app.unmount();
  }
});

test("Ctrl+G is advertised and active only for dismissible errors", async () => {
  const terminal = createTerminal(80, 24);
  let dismissals = 0;
  const app = render(
    <ErrorMessage message="Short notification error" width={40} onDismiss={() => dismissals++} />,
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
  expect(errorMessageHeight("Short notification error", 40, 2, true)).toBe(2);
  expect(Bun.stripANSI(terminal.output())).toContain("Ctrl+G dismiss");
  expect(terminal.output()).not.toContain("Ctrl+P");
  await sendInput(app, terminal.stdin, "\x07");
  expect(dismissals).toBe(1);

  terminal.clearOutput();
  app.rerender(<ErrorMessage message="Controlled save error" width={40} />);
  await app.waitUntilRenderFlush();
  expect(Bun.stripANSI(terminal.output())).not.toContain("Ctrl+G dismiss");
  await sendInput(app, terminal.stdin, "\x07");
  expect(dismissals).toBe(1);
  app.unmount();
});
