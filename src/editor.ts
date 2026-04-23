import { tmpdir } from "node:os";
import { join } from "node:path";

export async function editInNeovim(initial: string, filename: string): Promise<string> {
  const path = join(tmpdir(), `ifhj-${Date.now()}-${filename}`);
  await Bun.write(path, initial);

  const stdin = process.stdin;

  /**
   * Ink's useInput holds a `data` listener on stdin. Leave it attached and
   * every Neovim keystroke fires Ink handlers too — modals close, focus jumps.
   * Detach for the life of the editor, restore after.
   */
  const savedListeners = stdin.listeners("data") as ((chunk: Buffer | string) => void)[];
  for (const l of savedListeners) stdin.off("data", l);
  const wasRaw = stdin.isRaw;
  if (wasRaw) stdin.setRawMode(false);
  stdin.pause();

  /**
   * If anything below throws, stdin must still get restored or the app
   * locks up. try/finally is load-bearing.
   */
  try {
    const proc = Bun.spawn(["nvim", path], {
      stdio: ["inherit", "inherit", "inherit"],
    });
    await proc.exited;
    let text = initial;
    try {
      text = await Bun.file(path).text();
    } catch {
      // File was deleted from inside Neovim — treat as no-op, don't crash.
    }
    try {
      await Bun.file(path).unlink();
    } catch {}
    return text;
  } finally {
    if (wasRaw) stdin.setRawMode(true);
    stdin.resume();
    for (const l of savedListeners) stdin.on("data", l);
  }
}
