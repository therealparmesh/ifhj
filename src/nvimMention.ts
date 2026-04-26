import { tmpdir } from "node:os";
import { join } from "node:path";

import type { JiraUser } from "./jira";

/**
 * Vimscript we inject into Neovim when we open a description or comment.
 *
 * Shape:
 *   - `IfhjMentionSetup(json_path)` reads a JSON array of {id,name} and
 *     stashes it on the buffer.
 *   - `IfhjMentionComplete(findstart, base)` is the completefunc. Returns
 *     the `@` index on the first call; filtered candidates on the second.
 *   - Inserting from the menu yields `[@Display Name](jira-mention:<id>)`,
 *     which `textToAdf` in jira.ts turns into a real ADF mention.
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
            \\ 'word': '[@' . l:u.name . '](jira-mention:' . l:u.id . ')',
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

export type MentionAssets = {
  /** File containing the vimscript above — passed to --cmd source. */
  scriptPath: string;
  /** File containing JSON-encoded users — passed to IfhjMentionSetup. */
  usersPath: string;
  /** Cleanup both files. Swallows IO errors — they're in /tmp. */
  cleanup: () => Promise<void>;
};

/**
 * Drop a private temp copy of the script + users JSON and return their
 * paths. PID + timestamp in the names so concurrent ifhj sessions don't
 * clobber each other.
 */
export async function writeMentionAssets(users: JiraUser[]): Promise<MentionAssets> {
  const base = `ifhj-${process.pid}-${Date.now()}`;
  const scriptPath = join(tmpdir(), `${base}-mention.vim`);
  const usersPath = join(tmpdir(), `${base}-users.json`);
  const payload = users.map((u) => ({ id: u.accountId, name: u.displayName }));
  await Promise.all([
    Bun.write(scriptPath, VIMSCRIPT),
    Bun.write(usersPath, JSON.stringify(payload)),
  ]);
  return {
    scriptPath,
    usersPath,
    cleanup: async () => {
      await Promise.all(
        [scriptPath, usersPath].map(async (p) => {
          try {
            await Bun.file(p).unlink();
          } catch {}
        }),
      );
    },
  };
}
