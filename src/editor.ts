import { tmpdir } from "node:os";
import { join } from "node:path";

export async function editInNeovim(initial: string, filename: string): Promise<string> {
  const path = join(tmpdir(), `ifhj-${Date.now()}-${filename}`);
  await Bun.write(path, initial);

  const stdin = process.stdin;
  const stdout = process.stdout;

  const savedListeners = stdin.listeners("data") as ((chunk: Buffer | string) => void)[];
  const wasRaw = stdin.isRaw;

  try {
    for (const l of savedListeners) stdin.off("data", l);
    if (wasRaw) stdin.setRawMode(false);
    stdin.pause();
    stdout.write("\x1b[?1049h\x1b[?25h");

    const proc = Bun.spawn(["nvim", path], {
      stdio: ["inherit", "inherit", "inherit"],
    });
    await proc.exited;

    let text = initial;
    try {
      text = await Bun.file(path).text();
    } catch {}
    try {
      await Bun.file(path).unlink();
    } catch {}
    return text;
  } finally {
    stdout.write("\x1b[?1049l");
    if (wasRaw) stdin.setRawMode(true);
    stdin.resume();
    for (const l of savedListeners) stdin.on("data", l);
  }
}
