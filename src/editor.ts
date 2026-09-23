import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { setExternalScreenActive } from "./hooks";
import type { JiraUser } from "./jira";
import { writeMentionAssets } from "./nvimMention";

type EditOptions = {
  /**
   * When provided, the editor boots with an `@`-triggered completefunc fed by
   * this user list. Picking from the menu inserts an explicit
   * `[@Name](jira-mention:<id>)` link, which `textToAdf` turns into an ADF
   * mention on save. Plain `@foo` typed by hand stays plain text.
   */
  mentionUsers?: JiraUser[];
};

/**
 * Resolve the editor once: Neovim preferred, Vim as fallback. Cached — a
 * spawn per edit shouldn't re-probe `$PATH`. Both understand the `--cmd`/`-c`
 * mention injection (classic vimscript completefunc), so `@`-mentions work in
 * either.
 *
 * ponytail: `$EDITOR` is intentionally not honored — the injected script is
 * vim-family vimscript, so a generic editor (nano, code) would choke on the
 * args. If non-vim support is ever needed, gate the injection on the editor.
 */
let cachedEditor: { bin: string; label: string } | null | undefined;
function resolveEditor(): { bin: string; label: string } | null {
  if (cachedEditor === undefined) {
    cachedEditor = Bun.which("nvim")
      ? { bin: "nvim", label: "Neovim" }
      : Bun.which("vim")
        ? { bin: "vim", label: "Vim" }
        : null;
  }
  return cachedEditor;
}

/** Human name of the resolved editor for action labels and help. */
export function editorLabel(): string {
  return resolveEditor()?.label ?? "Neovim or Vim";
}

export async function editInNeovim(
  initial: string,
  filename: string,
  opts: EditOptions = {},
): Promise<string> {
  const editor = resolveEditor();
  if (!editor) {
    throw new Error("no editor found on $PATH — install Neovim or Vim (e.g. `mise use -g neovim`)");
  }
  const dir = await mkdtemp(join(tmpdir(), "ifhj-edit-"));
  const path = join(dir, basename(filename) || "edit.md");
  let assets: Awaited<ReturnType<typeof writeMentionAssets>> | null = null;

  const stdin = process.stdin;
  const stdout = process.stdout;

  const savedListeners = stdin.listeners("data") as ((chunk: Buffer | string) => void)[];
  const savedReadableListeners = stdin.listeners("readable") as (() => void)[];
  const readableListenersToRestore = new Set<(...args: unknown[]) => void>(savedReadableListeners);
  const originalOn = stdin.on;
  const originalAddListener = stdin.addListener;
  const originalOff = stdin.off;
  const originalRemoveListener = stdin.removeListener;
  const savedResizeListeners = stdout.listeners("resize") as (() => void)[];
  const wasRaw = stdin.isRaw;
  let inputDetached = false;
  let externalScreenOwned = false;
  let editorLaunched = false;
  let terminal: Bun.Terminal | null = null;
  let forwardInput: (() => void) | null = null;
  let forwardResize: (() => void) | null = null;
  let signalEditorResize: (() => void) | null = null;
  let text = initial;
  let failure: unknown;

  try {
    await writeFile(path, initial, { mode: 0o600 });
    // Empty user lists do not need completion assets.
    assets =
      opts.mentionUsers && opts.mentionUsers.length > 0
        ? await writeMentionAssets(opts.mentionUsers)
        : null;

    setExternalScreenActive(true);
    externalScreenOwned = true;
    for (const l of savedListeners) stdin.off("data", l);
    for (const listener of savedReadableListeners) stdin.off("readable", listener);
    inputDetached = true;
    const deferReadable = (
      original: typeof stdin.on,
      event: string | symbol,
      listener: (...args: unknown[]) => void,
    ) => {
      if (event === "readable") {
        readableListenersToRestore.add(listener);
        return stdin;
      }
      return original.call(stdin, event, listener);
    };
    stdin.on = ((event: string | symbol, listener: (...args: unknown[]) => void) =>
      deferReadable(originalOn, event, listener)) as typeof stdin.on;
    stdin.addListener = ((event: string | symbol, listener: (...args: unknown[]) => void) =>
      deferReadable(originalAddListener, event, listener)) as typeof stdin.addListener;
    const deferReadableRemoval = (
      original: typeof stdin.off,
      event: string | symbol,
      listener: (...args: unknown[]) => void,
    ) => {
      if (event === "readable") {
        readableListenersToRestore.delete(listener);
        return stdin;
      }
      return original.call(stdin, event, listener);
    };
    stdin.off = ((event: string | symbol, listener: (...args: unknown[]) => void) =>
      deferReadableRemoval(originalOff, event, listener)) as typeof stdin.off;
    stdin.removeListener = ((event: string | symbol, listener: (...args: unknown[]) => void) =>
      deferReadableRemoval(originalRemoveListener, event, listener)) as typeof stdin.removeListener;
    for (const listener of savedResizeListeners) stdout.off("resize", listener);
    stdin.pause();
    stdout.write("\x1b[?25h\x1b[2J\x1b[H");

    // A paused Bun stdin read can still consume keys from an inherited TTY.
    // Keep one parent reader and forward input to the editor's separate PTY.
    terminal = new Bun.Terminal({
      cols: stdout.columns || 80,
      rows: stdout.rows || 24,
      data: (_terminal, data) => stdout.write(data),
    });
    const editorTerminal = terminal;
    let terminalCols = stdout.columns || 80;
    let terminalRows = stdout.rows || 24;
    forwardResize = () => {
      let cols = stdout.columns || 80;
      let rows = stdout.rows || 24;
      try {
        // Bun can deliver SIGWINCH before it updates its cached dimensions.
        const measured = Bun.spawnSync(["stty", "size"], {
          stdin: stdin.fd,
          stdout: "pipe",
          stderr: "ignore",
        });
        const match =
          measured.exitCode === 0 && measured.stdout.toString().match(/^(\d+) (\d+)\s*$/);
        if (match) {
          rows = Number(match[1]);
          cols = Number(match[2]);
        }
      } catch {}
      if (cols !== terminalCols || rows !== terminalRows) {
        terminalCols = cols;
        terminalRows = rows;
        editorTerminal.resize(cols, rows);
        signalEditorResize?.();
      }
    };
    forwardInput = () => {
      let chunk: Buffer | string | null;
      while ((chunk = stdin.read()) !== null) editorTerminal.write(chunk);
    };
    originalOn.call(stdin, "readable", forwardInput);
    process.on("SIGWINCH", forwardResize);
    stdin.resume();

    // `--cmd` runs before user init (defines our functions); `-c` runs
    // after (so our buffer-local setup wins over any markdown autocmd the
    // user has configured). Vimscript string-literal single-quote needs
    // doubling — display names etc. are in the JSON file, not the args.
    const args: string[] = [];
    if (assets) {
      args.push("--cmd", `execute 'source ' . fnameescape(${vimString(assets.scriptPath)})`);
      args.push("-c", `call IfhjMentionSetup(${vimString(assets.usersPath)})`);
    }
    args.push(path);

    const proc = Bun.spawn([editor.bin, ...args], { terminal });
    editorLaunched = true;
    signalEditorResize = () => proc.kill("SIGWINCH");
    forwardResize();
    await proc.exited;
    if (proc.exitCode !== 0) throw new Error(`${editor.label} exited with status ${proc.exitCode}`);

    text = await readFile(path, "utf8");
  } catch (error) {
    failure = error;
  } finally {
    let restoreError: unknown;
    const restore = (fn: () => void) => {
      try {
        fn();
      } catch (error) {
        restoreError ??= error;
      }
    };
    try {
      if (inputDetached) {
        restore(() => stdin.pause());
        if (forwardInput) {
          const listener = forwardInput;
          restore(() => originalOff.call(stdin, "readable", listener));
        }
        if (forwardResize) {
          const listener = forwardResize;
          restore(() => process.off("SIGWINCH", listener));
        }
        if (terminal) {
          const editorTerminal = terminal;
          restore(() => editorTerminal.close());
        }
        restore(() => {
          stdin.on = originalOn;
        });
        restore(() => {
          stdin.addListener = originalAddListener;
        });
        restore(() => {
          stdin.off = originalOff;
        });
        restore(() => {
          stdin.removeListener = originalRemoveListener;
        });
        restore(() => stdout.write("\x1b[2J\x1b[H\x1b[?25l"));
        if (stdin.isRaw !== wasRaw) restore(() => stdin.setRawMode(wasRaw));
        for (const l of savedListeners) restore(() => stdin.on("data", l));
        for (const listener of readableListenersToRestore)
          restore(() => stdin.on("readable", listener));
        restore(() => stdin.resume());
        for (const listener of savedResizeListeners) restore(() => stdout.on("resize", listener));
      }
      if (externalScreenOwned) restore(() => setExternalScreenActive(false));
    } finally {
      if (assets) {
        try {
          await assets.cleanup();
        } catch (error) {
          restoreError ??= error;
        }
      }
    }
    failure ??= restoreError;
    if (!editorLaunched || !failure) {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }
  if (failure) {
    if (!editorLaunched) throw failure;
    const [draft, recoveryDir] = await Promise.all([inspectPath(path), inspectPath(dir)]);
    const detail = failure instanceof Error ? failure.message : String(failure);
    const inspectionErrors = [
      draft.error ? `draft: ${describeInspectionError(draft.error)}` : null,
      recoveryDir.error ? `directory: ${describeInspectionError(recoveryDir.error)}` : null,
    ].filter(Boolean);
    const recovery = inspectionErrors.length
      ? `Could not fully inspect recovery paths. Draft path: ${path}. Recovery directory: ${dir}. Inspection error: ${inspectionErrors.join("; ")}`
      : draft.info?.isFile()
        ? `Retained draft file: ${path}`
        : recoveryDir.info?.isDirectory()
          ? draft.info
            ? `Draft path is not a regular file: ${path}. Retained recovery directory: ${dir}`
            : `Retained recovery directory: ${dir}`
          : `No recovery file or directory remains at: ${dir}`;
    throw new Error(`${detail}. ${recovery}`, { cause: failure });
  }
  return text;
}

function vimString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

async function inspectPath(path: string) {
  try {
    return { info: await stat(path), error: null };
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    return code === "ENOENT" || code === "ENOTDIR"
      ? { info: null, error: null }
      : { info: null, error };
  }
}

function describeInspectionError(error: unknown): string {
  const code = error && typeof error === "object" && "code" in error ? `${error.code}: ` : "";
  return `${code}${error instanceof Error ? error.message : String(error)}`;
}
