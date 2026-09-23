import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
    if (wasRaw) stdin.setRawMode(false);
    stdin.pause();
    stdout.write("\x1b[?25h\x1b[2J\x1b[H");

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

    const proc = Bun.spawn([editor.bin, ...args], {
      stdio: ["inherit", "inherit", "inherit"],
    });
    await proc.exited;
    if (proc.exitCode !== 0) throw new Error(`${editor.label} exited with status ${proc.exitCode}`);

    try {
      text = await readFile(path, "utf8");
    } catch {}
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
        stdin.on = originalOn;
        stdin.addListener = originalAddListener;
        stdin.off = originalOff;
        stdin.removeListener = originalRemoveListener;
        restore(() => stdout.write("\x1b[2J\x1b[H\x1b[?25l"));
        if (wasRaw) restore(() => stdin.setRawMode(true));
        for (const l of savedListeners) restore(() => stdin.on("data", l));
        for (const listener of readableListenersToRestore)
          restore(() => stdin.on("readable", listener));
        restore(() => stdin.resume());
        for (const listener of savedResizeListeners) restore(() => stdout.on("resize", listener));
      }
      if (externalScreenOwned) setExternalScreenActive(false);
    } finally {
      try {
        if (assets) await assets.cleanup();
      } finally {
        await rm(dir, { recursive: true, force: true }).catch(() => {});
      }
    }
    failure ??= restoreError;
  }
  if (failure) throw failure;
  return text;
}

function vimString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}
