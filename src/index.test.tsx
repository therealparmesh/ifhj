import { describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";

import { runCli } from "./index";
import { isolatedEnv, makeTempDir, runScript } from "./test/utils";

const settings = { theme: "terminal" as const, maxColumns: 4 };
const config = { server: "https://jira.example.test", authHeader: "Basic test" };

function dependencies(overrides: Record<string, unknown> = {}) {
  return {
    loadSettings: async () => settings,
    loadConfig: async () => config,
    setTheme: () => {},
    mount: () => ({ waitUntilExit: async () => {} }),
    ...overrides,
  };
}

function within<T>(promise: Promise<T>, label: string, timeoutMs = 3_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

describe("CLI terminal lifecycle", () => {
  test("Esc aborts a pending real HTTP request so the process can exit", async () => {
    const home = await makeTempDir("pending-http-exit");
    let responseController: ReadableStreamDefaultController<Uint8Array> | undefined;
    let requestStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      requestStarted = resolve;
    });
    let requestAborted!: () => void;
    const aborted = new Promise<void>((resolve) => {
      requestAborted = resolve;
    });
    let child: ReturnType<typeof runScript> | undefined;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        requestStarted();
        request.signal.addEventListener("abort", requestAborted, { once: true });
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              responseController = controller;
              controller.enqueue(new TextEncoder().encode('{"values":['));
            },
          }),
          { headers: { "Content-Type": "application/json" } },
        );
      },
    });
    try {
      const source = `
        const { PassThrough } = await import("node:stream");
        const { render } = await import("ink");
        const { createTerminal } = await import("./src/test/utils.ts");
        const { runCli } = await import("./src/index.tsx");
        const terminal = createTerminal(80, 24);
        const nativeFetch = globalThis.fetch;
        let markInputReady;
        const inputReady = new Promise((resolve) => { markInputReady = resolve; });
        let exitScheduled = false;
        globalThis.fetch = async (...args) => {
          const response = await nativeFetch(...args);
          await inputReady;
          if (!exitScheduled) {
            exitScheduled = true;
            setImmediate(() => {
              terminal.stdin.write("\\u001b");
              terminal.stdin.emit("readable");
            });
          }
          return response;
        };
        await runCli({
          loadSettings: async () => ({ theme: "terminal", maxColumns: 4 }),
          loadConfig: async () => ({ server: ${JSON.stringify(server.url.origin)}, authHeader: "Basic synthetic" }),
          setTheme() {},
          mount(node, options) {
            const app = render(node, {
              ...options,
              interactive: true,
              stdin: terminal.stdin,
              stdout: terminal.stdout,
              stderr: new PassThrough(),
              exitOnCtrlC: false,
              patchConsole: false,
            });
            app.waitUntilRenderFlush().then(markInputReady);
            return app;
          },
        });
        console.log(JSON.stringify({ exited: true, terminal: terminal.output() }));
      `;
      child = runScript(source, isolatedEnv(home), import.meta.dir + "/..", 3_500);
      await within(started, "server request");
      const [result] = await within(Promise.all([child, aborted]), "CLI exit and request abort");
      expect(result.exitCode, result.stderr).toBe(0);
      const lifecycle = JSON.parse(result.stdout) as { exited: boolean; terminal: string };
      expect(lifecycle.exited).toBeTrue();
      expect(lifecycle.terminal.indexOf("\x1b[?1049h")).toBeGreaterThanOrEqual(0);
      expect(lifecycle.terminal.indexOf("\x1b[?1049l")).toBeGreaterThan(
        lifecycle.terminal.indexOf("\x1b[?1049h"),
      );
    } finally {
      try {
        responseController?.close();
      } catch {}
      server.stop(true);
      await child?.catch(() => {});
      await rm(home, { recursive: true, force: true });
    }
  });

  test("does not enter the alternate screen when startup configuration fails", async () => {
    let mounted = false;
    const failure = new Error("missing token");

    await expect(
      runCli(
        dependencies({
          loadConfig: async () => {
            throw failure;
          },
          mount: () => {
            mounted = true;
            return { waitUntilExit: async () => {} };
          },
        }),
      ),
    ).rejects.toBe(failure);
    expect(mounted).toBeFalse();
  });

  test("Ink restores the primary screen after a render failure", async () => {
    const home = await makeTempDir("render-failure");
    try {
      const { exitCode, stdout, stderr } = await runScript(
        `
            Object.defineProperty(process.stdout, "isTTY", { value: true });
            const React = await import("react");
            const { render } = await import("ink");
            const { runCli } = await import("./src/index.tsx");
            const Broken = () => { throw new Error("render failed"); };
            try {
              await runCli({
                loadSettings: async () => ({ theme: "terminal", maxColumns: 4 }),
                loadConfig: async () => ({ server: "https://failure.invalid", authHeader: "Basic test" }),
                setTheme() {},
                mount(_node, options) {
                  return render(React.createElement(Broken), {
                    ...options,
                    interactive: true,
                    patchConsole: false,
                  });
                },
              });
            } catch { process.stdout.write("CAUGHT\\n"); }
          `,
        isolatedEnv(home),
        import.meta.dir + "/..",
      );
      expect(exitCode, stderr).toBe(0);
      expect(stdout).toContain("\x1b[?1049h");
      expect(stdout).toContain("\x1b[?1049l");
      expect(stdout).toContain("CAUGHT\n");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    test(`Ink restores the primary screen on ${signal}`, async () => {
      const home = await makeTempDir(`signal-${signal.toLowerCase()}`);
      let stopChild: (() => Promise<void>) | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const child = Bun.spawn(
          [
            process.execPath,
            "-e",
            `
              Object.defineProperty(process.stdout, "isTTY", { value: true });
              const { render } = await import("ink");
              const { runCli } = await import("./src/index.tsx");
              globalThis.fetch = async () => Response.json({ values: [], isLast: true });
              await runCli({
                loadSettings: async () => ({ theme: "terminal", maxColumns: 4 }),
                loadConfig: async () => ({ server: "https://signal.invalid", authHeader: "Basic test" }),
                setTheme() {},
                mount(node, options) {
                  const app = render(node, { ...options, interactive: true, patchConsole: false });
                  app.waitUntilRenderFlush().then(() => process.stdout.write("READY\\n"));
                  return app;
                },
              });
            `,
          ],
          {
            cwd: import.meta.dir + "/..",
            env: isolatedEnv(home),
            stdout: "pipe",
            stderr: "pipe",
          },
        );
        stopChild = async () => {
          if (child.exitCode === null) child.kill();
          const exited = await within(child.exited, "signal child cleanup", 250).then(
            () => true,
            () => false,
          );
          if (!exited && child.exitCode === null) child.kill("SIGKILL");
          await child.exited.catch(() => {});
        };
        timer = setTimeout(() => child.kill("SIGKILL"), 3_000);
        const reader = child.stdout.getReader();
        let output = "";
        while (!output.includes("READY\n")) {
          const chunk = await reader.read();
          if (chunk.done) break;
          output += new TextDecoder().decode(chunk.value);
        }
        expect(output).toContain("READY\n");
        child.kill(signal);
        const exited = await within(child.exited, `${signal} child exit`, 1_500).then(
          () => true,
          () => false,
        );
        if (!exited && child.exitCode === null) child.kill("SIGKILL");
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          output += new TextDecoder().decode(chunk.value);
        }
        await child.exited;
        expect(output).toContain("\x1b[?1049h");
        expect(output).toContain("\x1b[?1049l");
        expect(output.lastIndexOf("\x1b[?25h")).toBeGreaterThan(output.indexOf("\x1b[?1049h"));
      } finally {
        if (timer) clearTimeout(timer);
        await stopChild?.();
        await rm(home, { recursive: true, force: true });
      }
    });
  }
});
