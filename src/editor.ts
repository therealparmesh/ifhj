import { tmpdir } from "node:os";
import { join } from "node:path";

import type { JiraUser } from "./jira";
import { writeMentionAssets } from "./nvimMention";

type EditOptions = {
  /**
   * When provided, Neovim boots with an `@`-triggered completefunc fed by
   * this user list. Picking from the menu inserts an explicit
   * `[@Name](jira-mention:<id>)` link, which `textToAdf` turns into an ADF
   * mention on save. Plain `@foo` typed by hand stays plain text.
   */
  mentionUsers?: JiraUser[];
};

export async function editInNeovim(
  initial: string,
  filename: string,
  opts: EditOptions = {},
): Promise<string> {
  const path = join(tmpdir(), `ifhj-${Date.now()}-${filename}`);
  await Bun.write(path, initial);

  // Only stand up mention assets when there's actually a non-empty user
  // list. Empty list → spawn plain nvim (same as before the feature).
  const assets =
    opts.mentionUsers && opts.mentionUsers.length > 0
      ? await writeMentionAssets(opts.mentionUsers)
      : null;

  const stdin = process.stdin;
  const stdout = process.stdout;

  const savedListeners = stdin.listeners("data") as ((chunk: Buffer | string) => void)[];
  const wasRaw = stdin.isRaw;

  try {
    for (const l of savedListeners) stdin.off("data", l);
    if (wasRaw) stdin.setRawMode(false);
    stdin.pause();
    stdout.write("\x1b[?1049h\x1b[?25h");

    // `--cmd` runs before user init (defines our functions); `-c` runs
    // after (so our buffer-local setup wins over any markdown autocmd the
    // user has configured). Vimscript string-literal single-quote needs
    // doubling — display names etc. are in the JSON file, not the args.
    const args: string[] = [];
    if (assets) {
      args.push("--cmd", `source ${assets.scriptPath}`);
      args.push("-c", `call IfhjMentionSetup('${assets.usersPath.replaceAll("'", "''")}')`);
    }
    args.push(path);

    const proc = Bun.spawn(["nvim", ...args], {
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
    if (assets) await assets.cleanup();
  }
}
