# ifhj

**i freaking have jira** - a TUI for Jira. Kanban board, issue editing, field management, comments, transitions, filters, the whole thing from the terminal.

I don't want to context-switch to a browser tab to move a card. This is the fix.

## Install

### mise (recommended)

```sh
mise use -g github:therealparmesh/ifhj
```

### Download the binary

Grab the tarball for your OS/arch from the [latest release](https://github.com/therealparmesh/ifhj/releases), extract, drop on `$PATH`.

Assets are named `ifhj_<version>_<darwin|linux>_<amd64|arm64>.tar.gz`.

### From source

Needs [bun](https://bun.sh) >= 1.3.

```sh
git clone https://github.com/therealparmesh/ifhj
cd ifhj
bun install
bun run compile
mv ifhj /usr/local/bin/
```

## Prerequisites

### Neovim

ifhj shells out to `nvim` for descriptions, comments, and the create form. Needs to be on `$PATH`.

```sh
mise use -g neovim
```

### Jira API token

Generate one at <https://id.atlassian.com/manage-profile/security/api-tokens>.

```sh
export JIRA_API_TOKEN="<token>"
```

### Server and login

Either env vars or a yaml file.

**Env vars:**

```sh
export JIRA_SERVER="https://your-company.atlassian.net"
export JIRA_LOGIN="you@your-company.com"
```

**Or `~/.config/.jira/.config.yml`** (same format as [jira-cli](https://github.com/ankitpokhrel/jira-cli) - if you already use that, ifhj picks it up for free):

```yaml
server: https://your-company.atlassian.net
login: you@your-company.com
```

Env vars win when both are set.

### Theme

ifhj ships with two themes: `synthwave` (default) and `terminal`. The `terminal` theme defers to your terminal's own color palette.

Set it in `~/.config/ifhj/settings.json`:

```json
{
  "theme": "terminal"
}
```

Or override per-invocation with `IFHJ_THEME`:

```sh
IFHJ_THEME=terminal ifhj
```

## Usage

```sh
ifhj
```

Pick a board. Everything's keyboard from there.

## Keybindings

### Board

| Key                 | Action                                            |
| ------------------- | ------------------------------------------------- |
| `← → h l`           | move between columns                              |
| `↑ ↓ j k`           | move within column                                |
| `g` / `G`           | top / bottom of column                            |
| `PgUp` / `PgDn`     | page within column                                |
| `Enter`             | card action menu                                  |
| `v`                 | view issue details                                |
| `e`                 | edit title (inline)                               |
| `E`                 | edit description (Neovim)                         |
| `t`                 | transition to any status                          |
| `m`                 | move to any column                                |
| `< >`               | transition to prev / next column                  |
| `Ctrl+,` / `Ctrl+.` | rerank card up / down                             |
| `i`                 | assign to me                                      |
| `y` / `Y`           | yank issue key / URL                              |
| `o` / `O`           | open card / board in browser                      |
| `c`                 | create issue                                      |
| `a`                 | quick add to current column                       |
| `/`                 | search                                            |
| `n` / `N`           | next / prev search match                          |
| `f`                 | filter menu (assignee, type, sprint, label, epic) |
| `F`                 | clear all filters                                 |
| `R`                 | recent issues                                     |
| `J`                 | JQL query view                                    |
| `r`                 | refresh                                           |
| `?`                 | help                                              |
| `q`                 | back to board picker                              |

### Detail view

| Key             | Action                          |
| --------------- | ------------------------------- |
| `Tab`           | switch pane (body / fields)     |
| `↑ ↓ j k`       | scroll body / move field cursor |
| `g` / `G`       | top / bottom                    |
| `PgUp` / `PgDn` | page scroll                     |
| `Enter`         | edit field or open comment      |
| `x`             | clear field                     |
| `[ ]`           | prev / next comment             |
| `c`             | add comment (Neovim)            |
| `C`             | create subtask                  |
| `e`             | edit title (inline)             |
| `E`             | edit description (Neovim)       |
| `t`             | transition to status            |
| `m`             | move to column                  |
| `w`             | toggle watch / unwatch          |
| `y` / `Y`       | yank issue key / URL            |
| `o`             | open in browser                 |
| `r`             | refresh                         |
| `Esc` / `q`     | close                           |

### Editable fields

Assignee, priority, parent, story points, labels, components, fix versions, due date. Tab to the fields pane, Enter to edit, `x` to clear. Array fields (labels, components, fix versions) give you add/remove/clear options.

### Custom fields

Project-specific custom fields (team-managed or classic) show up read-only in the side panel — whatever your project exposes via `editmeta`, rendered as display text. Editing them well would mean covering Jira's whole type surface (user pickers, cascades, rich-text ADF, etc.) and the partial story is worse than honest read-only. Flip to the web UI for changes.

### Markdown

Descriptions and comments round-trip as Markdown. Write Markdown in Neovim, it gets converted to Jira's ADF format on save. ADF from Jira gets converted back to Markdown for display.

### @mentions

In a description or comment, type `@`. Neovim opens a completion menu of the project's assignable users — pick one and it inserts `[@Name](jira-mention:<id>)`. On save, that becomes a real Jira mention.

Plain `@foo` that you type yourself stays as literal text. The mention is whatever came out of the menu — no guessing.

The completion source is injected via `--cmd` / `-c` and is buffer-local, so it doesn't touch your regular Neovim config.

### Stats

Each column header shows the card count, the sum of story points when non-zero, and — if the board config sets a WIP limit — `count/max`, red when over. The board header rolls up the visible-issue point total.

### Caching

Board state is cached at `~/.cache/ifhj/` for instant startup. Stale after 10 minutes. Fresh data loads in the background and replaces the cache.

## Development

```sh
bun install
bun run dev            # hot reload
bun run lint           # oxfmt + oxlint + tsc
bun run compile        # native binary
```

### Cutting a release

```sh
./scripts/release.ts patch  # or: minor | major | 1.2.3
```

Bumps version, commits, tags, pushes. GitHub Actions cross-compiles for darwin/linux x amd64/arm64.

## Author

[@therealparmesh](https://github.com/therealparmesh)

## License

MIT
