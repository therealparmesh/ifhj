import { expect, test } from "bun:test";
import { PassThrough } from "node:stream";

import { render, Text } from "ink";

import { useToasts } from "./Toasts";

test("unmount clears toast timers and ignores late error flashes", async () => {
  const originalWrite = process.stderr.write;
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  let toastTimer: ReturnType<typeof setTimeout> | undefined;
  const cleared: unknown[] = [];
  let bells = 0;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    if (String(chunk).includes("\x07")) bells++;
    return true;
  }) as typeof process.stderr.write;
  globalThis.setTimeout = ((callback: (...args: any[]) => void, delay?: number) => {
    const timer = originalSetTimeout(callback, delay);
    if (delay === 3500) toastTimer = timer;
    return timer;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((value: ReturnType<typeof setTimeout>) => {
    if (value === toastTimer) cleared.push(value);
    originalClearTimeout(value);
  }) as typeof clearTimeout;

  let flash!: (text: string, tone?: "ok" | "err" | "info") => void;
  let app: ReturnType<typeof render> | undefined;
  function Harness() {
    const state = useToasts();
    flash = state.flash;
    return <Text>{state.toasts.length}</Text>;
  }

  try {
    app = render(<Harness />, {
      stdout: new PassThrough() as unknown as typeof process.stdout,
      stderr: new PassThrough() as unknown as typeof process.stderr,
      patchConsole: false,
    });
    await app.waitUntilRenderFlush();
    flash("live", "err");
    await app.waitUntilRenderFlush();
    expect(bells).toBe(1);

    app.unmount();
    await app.waitUntilExit();
    expect(cleared).toEqual([toastTimer]);
    flash("late", "err");
    expect(bells).toBe(1);
  } finally {
    app?.unmount();
    process.stderr.write = originalWrite;
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
});
