import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

export function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

export function createTerminal(columns = 120, rows = 40) {
  const stdin = new PassThrough() as PassThrough & {
    isTTY: boolean;
    setRawMode: (raw: boolean) => void;
    ref: () => void;
    unref: () => void;
  };
  stdin.isTTY = true;
  stdin.setRawMode = () => {};
  stdin.ref = () => {};
  stdin.unref = () => {};

  const stdout = new PassThrough() as PassThrough & {
    columns: number;
    rows: number;
    isTTY: boolean;
  };
  stdout.columns = columns;
  stdout.rows = rows;
  stdout.isTTY = true;
  let output = "";
  stdout.on("data", (chunk) => {
    output += String(chunk);
  });

  return {
    stdin,
    stdout,
    output: () => output,
    clearOutput: () => {
      output = "";
    },
  };
}

export async function waitFor(
  check: () => boolean | Promise<boolean>,
  label: string,
  timeoutMs = 3_000,
): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (await check()) return;
    await Bun.sleep(10);
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}`);
}

export function nextTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

export async function sendInput(
  app: { waitUntilRenderFlush: () => Promise<void> },
  stdin: { write: (input: string) => unknown },
  input: string,
): Promise<void> {
  await nextTurn();
  await app.waitUntilRenderFlush();
  stdin.write(input);
  if (input === "\u001b") await Bun.sleep(20);
  else await nextTurn();
  await app.waitUntilRenderFlush();
}

export async function runScript(
  source: string,
  env: Record<string, string | undefined>,
  cwd?: string,
  timeoutMs = 4_000,
) {
  const child = Bun.spawn([process.execPath, "-e", source], {
    env,
    ...(cwd ? { cwd } : {}),
    stdout: "pipe",
    stderr: "pipe",
  });
  let timedOut = false;
  let termination: Promise<void> | undefined;
  let forceTimer: ReturnType<typeof setTimeout> | undefined;
  const stopChild = async () => {
    if (child.exitCode === null) {
      child.kill();
      forceTimer = setTimeout(() => child.kill("SIGKILL"), 100);
    }
    try {
      await child.exited;
    } finally {
      if (forceTimer) clearTimeout(forceTimer);
    }
  };
  const timer = setTimeout(() => {
    timedOut = true;
    termination = stopChild();
  }, timeoutMs);
  try {
    try {
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      if (timedOut) throw new Error(`child timed out after ${timeoutMs}ms`);
      return { exitCode, stdout, stderr };
    } catch (error) {
      termination ??= stopChild();
      await termination;
      throw error;
    }
  } finally {
    clearTimeout(timer);
    await termination;
  }
}

export function isolatedEnv(
  home: string,
  overrides: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  return {
    ...process.env,
    HOME: home,
    XDG_CACHE_HOME: join(home, ".cache"),
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_STATE_HOME: join(home, ".local", "state"),
    EDITOR: undefined,
    VISUAL: undefined,
    IFHJ_MAX_COLUMNS: undefined,
    IFHJ_THEME: undefined,
    JIRA_API_TOKEN: undefined,
    JIRA_EMAIL: undefined,
    JIRA_LOGIN: undefined,
    JIRA_SERVER: undefined,
    ...overrides,
  };
}

export function makeTempDir(name: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `ifhj-${name}-`));
}
