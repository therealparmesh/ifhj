import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { JiraUser } from "./jira";

/**
 * Vimscript we inject into Neovim when we open a description or comment.
 *
 * Shape:
 *   - `IfhjMentionSetup(json_path)` reads JSON mention candidates and
 *     stashes it on the buffer.
 *   - `IfhjMentionComplete(findstart, base)` is the completefunc. Returns
 *     the `@` index on the first call; filtered candidates on the second.
 *   - Inserting from the menu yields `[@Display Name](jira-mention:<id>)`,
 *     which `textToAdf` in adf.ts turns into a real ADF mention.
 *   - Buffer-local: we only touch the buffer we're invoked on, so we don't
 *     leak into other buffers the user happens to have open.
 *
 * Set via `--cmd "source <path>"` before user init (defines functions) and
 * `-c "call IfhjMentionSetup('<path>')"` after user init (attaches to the
 * buffer, overriding any autocmd-configured completefunc).
 */
const VIMSCRIPT = `
function! IfhjMentionComplete(findstart, base) abort
  if a:findstart
    " Locate the '@' that starts the current token.
    let l:line = getline('.')
    let l:col = col('.') - 1
    let l:start = l:col
    while l:start > 0 && l:line[l:start - 1] =~# '[A-Za-z0-9._-]'
      let l:start -= 1
    endwhile
    if l:start > 0 && l:line[l:start - 1] ==# '@'
      return l:start - 1
    endif
    return -3
  endif
  let l:users = get(b:, 'ifhj_mention_users', [])
  let l:query = tolower(substitute(a:base, '^@', '', ''))
  let l:out = []
  for l:u in l:users
    if empty(l:query) || stridx(tolower(l:u.name), l:query) >= 0
      call add(l:out, {
            \\ 'word': '[@' . l:u.markdownName . '](jira-mention:' . l:u.markdownId . ')',
            \\ 'abbr': '@' . l:u.name,
            \\ 'menu': '[mention]',
            \\ })
    endif
  endfor
  return l:out
endfunction

function! IfhjMentionSetup(path) abort
  try
    let l:raw = join(readfile(a:path), "\\n")
    let b:ifhj_mention_users = json_decode(l:raw)
  catch
    let b:ifhj_mention_users = []
    return
  endtry
  if empty(b:ifhj_mention_users)
    return
  endif
  setlocal completefunc=IfhjMentionComplete
  " Auto-trigger: after typing '@', open the menu so the user doesn't have
  " to remember <C-x><C-u>. Still works mid-word (e.g. in an email) — they
  " just escape out.
  inoremap <buffer> @ @<C-x><C-u>
endfunction
`;

type MentionAssets = {
  /** File containing the vimscript above — passed to --cmd source. */
  scriptPath: string;
  /** File containing JSON-encoded users — passed to IfhjMentionSetup. */
  usersPath: string;
  /** Cleanup the private asset directory. Swallows temporary-file IO errors. */
  cleanup: () => Promise<void>;
};

/**
 * Drop a private temp copy of the script and users JSON and return their paths.
 */
export async function writeMentionAssets(users: JiraUser[]): Promise<MentionAssets> {
  const dir = await mkdtemp(join(tmpdir(), "ifhj-mention-"));
  const scriptPath = join(dir, "mention.vim");
  const usersPath = join(dir, "users.json");
  try {
    // CommonMark allows a backslash escape for every ASCII punctuation character.
    const payload = users.map((u) => ({
      name: u.displayName,
      markdownId: encodeURIComponent(u.accountId),
      markdownName: u.displayName.replaceAll(/[!-/:-@[-`{-~]/g, (char) =>
        char === "&" ? "&amp;" : `\\${char}`,
      ),
    }));
    await writeFile(scriptPath, VIMSCRIPT, { mode: 0o600 });
    await writeFile(usersPath, JSON.stringify(payload), { mode: 0o600 });
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
  return {
    scriptPath,
    usersPath,
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    },
  };
}
