import { expect, test } from "bun:test";
import { PassThrough } from "node:stream";

import { render, Text } from "ink";

import { createTerminal, sendInput, waitFor } from "../test/utils";
import { ToastStack, type Toast, useToasts } from "./Toasts";

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
      interactive: true,
      stdout: new PassThrough() as unknown as typeof process.stdout,
      stderr: new PassThrough() as unknown as typeof process.stderr,
      patchConsole: false,
    });
    await app.waitUntilRenderFlush();
    flash("live", "info");
    flash("persistent error", "err");
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

test("error toasts do not expire while their details are being read", async () => {
  const originalSetTimeout = globalThis.setTimeout;
  let toastTimers = 0;
  globalThis.setTimeout = ((callback: (...args: any[]) => void, delay?: number) => {
    if (delay === 3500) toastTimers++;
    return originalSetTimeout(callback, delay);
  }) as typeof setTimeout;
  let flash!: (text: string, tone?: "ok" | "err" | "info") => void;
  let current: Toast[] = [];
  function Harness() {
    const state = useToasts();
    flash = state.flash;
    current = state.toasts;
    return <ToastStack toasts={state.toasts} maxWidth={80} />;
  }
  const terminal = createTerminal(80, 24);
  const app = render(<Harness />, {
    interactive: true,
    stdin: terminal.stdin as unknown as typeof process.stdin,
    stdout: terminal.stdout as unknown as typeof process.stdout,
    stderr: new PassThrough() as unknown as typeof process.stderr,
    exitOnCtrlC: false,
    patchConsole: false,
  });
  try {
    await app.waitUntilRenderFlush();
    flash(`persistent ${"reason ".repeat(30)} END`, "err");
    await waitFor(() => current.length === 1, "persistent error toast");
    await sendInput(app, terminal.stdin, "\x10");
    expect(current[0]?.text).toContain("END");
    expect(toastTimers).toBe(0);
  } finally {
    app.unmount();
    globalThis.setTimeout = originalSetTimeout;
  }
});

test("error-priority insertion retains the error when the stack fills", async () => {
  let flash!: (text: string, tone?: "ok" | "err" | "info") => void;
  let current: Toast[] = [];
  function Harness() {
    const state = useToasts();
    flash = state.flash;
    current = state.toasts;
    return <Text>{state.toasts.map((toast) => toast.text).join("|")}</Text>;
  }
  const app = render(<Harness />, {
    interactive: true,
    stdout: new PassThrough() as unknown as typeof process.stdout,
    stderr: new PassThrough() as unknown as typeof process.stderr,
    patchConsole: false,
  });
  try {
    await app.waitUntilRenderFlush();
    flash("important error", "err");
    flash("info one", "info");
    flash("info two", "info");
    flash("info three", "info");
    await waitFor(() => current.length === 3, "bounded toast state");
    expect(current.map((toast) => toast.text)).toEqual([
      "important error",
      "info two",
      "info three",
    ]);
  } finally {
    app.unmount();
  }
});

test("multiple errors share one active paging owner", async () => {
  const terminal = createTerminal(80, 24);
  const errors: Toast[] = [
    { id: 1, tone: "err", text: `first ${"reason ".repeat(30)}FIRST_END` },
    { id: 2, tone: "err", text: `second ${"reason ".repeat(30)}SECOND_END` },
  ];
  const app = render(<ToastStack toasts={errors} maxWidth={80} />, {
    interactive: true,
    stdin: terminal.stdin as unknown as typeof process.stdin,
    stdout: terminal.stdout as unknown as typeof process.stdout,
    stderr: new PassThrough() as unknown as typeof process.stderr,
    exitOnCtrlC: false,
    patchConsole: false,
  });
  try {
    await app.waitUntilRenderFlush();
    expect(Bun.stripANSI(terminal.output()).match(/Ctrl\+P/g)).toHaveLength(1);
    await sendInput(app, terminal.stdin, "\x10");
    expect(terminal.output()).toContain("2/");
  } finally {
    app.unmount();
  }
});

test("Ctrl+G dismisses the toast stack and clears live timers", async () => {
  const originalClearTimeout = globalThis.clearTimeout;
  let cleared = 0;
  globalThis.clearTimeout = ((timer: ReturnType<typeof setTimeout>) => {
    cleared++;
    originalClearTimeout(timer);
  }) as typeof clearTimeout;
  const terminal = createTerminal(80, 24);
  let flash!: (text: string, tone?: "ok" | "err" | "info") => void;
  let dismiss!: () => void;
  let current: Toast[] = [];
  function Harness() {
    const state = useToasts();
    flash = state.flash;
    dismiss = state.dismiss;
    current = state.toasts;
    return <ToastStack toasts={state.toasts} maxWidth={80} onDismiss={state.dismiss} />;
  }
  const app = render(<Harness />, {
    interactive: true,
    stdin: terminal.stdin as unknown as typeof process.stdin,
    stdout: terminal.stdout as unknown as typeof process.stdout,
    stderr: new PassThrough() as unknown as typeof process.stderr,
    exitOnCtrlC: false,
    patchConsole: false,
  });
  try {
    await app.waitUntilRenderFlush();
    flash("persistent error", "err");
    flash("timed info", "info");
    await waitFor(() => current.length === 2, "dismissible notifications");
    await waitFor(() => terminal.output().includes("Ctrl+G dismiss"), "dismiss hint");
    await sendInput(app, terminal.stdin, "\x07");
    await waitFor(() => current.length === 0, "dismissed notifications");
    expect(cleared).toBeGreaterThan(0);
    app.unmount();
    dismiss();
    expect(current).toEqual([]);
  } finally {
    app.unmount();
    globalThis.clearTimeout = originalClearTimeout;
  }
});
