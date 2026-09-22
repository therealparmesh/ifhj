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

describe("CLI terminal lifecycle", () => {
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

  test("enables Ink-owned alternate-screen cleanup", async () => {
    let options: { alternateScreen: boolean } | undefined;
    await runCli(
      dependencies({
        mount: (_node: unknown, received: { alternateScreen: boolean }) => {
          options = received;
          return { waitUntilExit: async () => {} };
        },
      }),
    );
    expect(options).toEqual({ alternateScreen: true });
  });

  test("Ink restores the primary screen after a render failure", async () => {
    const home = await makeTempDir("render-failure");
    try {
      const { exitCode, stdout, stderr } = await runScript(
        `
            Object.defineProperty(process.stdout, "isTTY", { value: true });
            const React = await import("react");
            const { render } = await import("ink");
            const Broken = () => { throw new Error("render failed"); };
            const app = render(React.createElement(Broken), {
              alternateScreen: true,
              patchConsole: false,
            });
            try { await app.waitUntilExit(); } catch { process.stdout.write("CAUGHT\\n"); }
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
              const React = await import("react");
              const { render, Text } = await import("ink");
              render(React.createElement(Text, null, "ready"), {
                alternateScreen: true,
                patchConsole: false,
              });
              process.stdout.write("READY\\n");
              setInterval(() => {}, 1000);
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
          await child.exited.catch(() => {});
        };
        timer = setTimeout(() => child.kill(), 3_000);
        const reader = child.stdout.getReader();
        let output = "";
        while (!output.includes("READY\n")) {
          const chunk = await reader.read();
          if (chunk.done) break;
          output += new TextDecoder().decode(chunk.value);
        }
        child.kill(signal);
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
