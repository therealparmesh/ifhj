import { expect, test } from "bun:test";
import { PassThrough } from "node:stream";

import { render, renderToString } from "ink";

import { ProgressBar } from "./ProgressBar";

const noopAdvance = () => {};

test("later timer phases keep an active cell at narrow widths and clean up", async () => {
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  let advance = noopAdvance;
  let progressTimer: ReturnType<typeof setInterval> | undefined;
  const cleared: unknown[] = [];
  globalThis.setInterval = ((callback: () => void, delay?: number) => {
    if (delay !== 90) return originalSetInterval(callback, delay);
    advance = callback;
    progressTimer = { progress: true } as unknown as ReturnType<typeof setInterval>;
    return progressTimer;
  }) as typeof setInterval;
  globalThis.clearInterval = ((value: ReturnType<typeof setInterval>) => {
    if (value === progressTimer) cleared.push(value);
    else originalClearInterval(value);
  }) as typeof clearInterval;

  const stdout = new PassThrough() as PassThrough & {
    columns: number;
    rows: number;
    isTTY: boolean;
  };
  stdout.columns = 10;
  stdout.rows = 2;
  stdout.isTTY = true;
  let output = "";
  let app: ReturnType<typeof render> | undefined;
  stdout.on("data", (chunk) => {
    output += String(chunk);
  });

  try {
    app = render(<ProgressBar width={1} active />, {
      stdout: stdout as unknown as typeof process.stdout,
      stderr: new PassThrough() as unknown as typeof process.stderr,
      patchConsole: false,
    });
    await app.waitUntilRenderFlush();
    expect(output).toContain("━");
    const firstTimer = progressTimer;

    advance();
    await app.waitUntilRenderFlush();
    app.rerender(<ProgressBar width={4} active />);
    await app.waitUntilRenderFlush();
    expect(Bun.stripANSI(output)).toContain("─━━━");

    output = "";
    app.rerender(<ProgressBar width={1} active />);
    await app.waitUntilRenderFlush();
    expect(output).toContain("━");
    expect(output).not.toContain("─");

    app.rerender(<ProgressBar width={1} active={false} />);
    await app.waitUntilRenderFlush();
    expect(cleared).toEqual([firstTimer]);

    app.rerender(<ProgressBar width={2} active />);
    await app.waitUntilRenderFlush();
    const secondTimer = progressTimer;
    app.unmount();
    expect(cleared).toEqual([firstTimer, secondTimer]);
  } finally {
    app?.unmount();
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
  }
});

test("narrow active and inactive renders keep their declared width", () => {
  for (const width of [1, 2, 3]) {
    expect(Bun.stringWidth(renderToString(<ProgressBar width={width} active />))).toBe(width);
  }
  expect(renderToString(<ProgressBar width={1} active={false} />)).toBe("");
});
