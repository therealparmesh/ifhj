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

### Neovim (or Vim)

ifhj shells out to an editor for descriptions, comments, and the create form. It prefers `nvim` and falls back to `vim` — one of them needs to be on `$PATH`.

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

Env vars win when both are set. `JIRA_EMAIL` is an alias for `JIRA_LOGIN`. If the first YAML path is absent, ifhj also checks `~/.config/jira/.config.yml`.

### Settings

User preferences live in `~/.config/ifhj/settings.json`:

```json
{
  "theme": "terminal",
  "maxColumns": 6
}
```

| Key          | Default       | Env override       | Description                                 |
| ------------ | ------------- | ------------------ | ------------------------------------------- |
| `theme`      | `"synthwave"` | `IFHJ_THEME`       | Color theme (`synthwave` or `terminal`)     |
| `maxColumns` | `4`           | `IFHJ_MAX_COLUMNS` | Max visible board columns before ←/→ paging |

The `terminal` theme defers to your terminal's own color palette — readable on both light and dark backgrounds.
The default `synthwave` theme assumes a dark terminal background.

## Usage

```sh
ifhj
```

Pick a board. Everything's keyboard from there.

Press `?` for help. Scroll with the Up/Down arrow keys or Page Up/Page Down; Home/End jumps to either end. ifhj needs at least an 80×24 terminal and keeps the current screen state while you resize.

Pickers and required-field screens scroll to keep the selected row and controls visible on standard 80×24 terminals. Long picker queries scroll horizontally with the cursor.

## Keybindings

### Board

| Key             | Action                                             |
| --------------- | -------------------------------------------------- |
| `← → h l`       | move between columns                               |
| `↑ ↓ j k`       | move within column                                 |
| `g` / `G`       | top / bottom of column                             |
| `PgUp` / `PgDn` | page within column                                 |
| `Enter`         | card action menu                                   |
| `v`             | view issue details                                 |
| `e`             | edit title (inline)                                |
| `E`             | edit description (editor)                          |
| `t`             | choose an available workflow transition            |
| `m`             | move to any column                                 |
| `< >`           | transition to prev / next column                   |
| `[ ]`           | rerank card up / down within column                |
| `i`             | assign to me                                       |
| `y` / `Y`       | copy issue key / URL                               |
| `o` / `O`       | open card / board in browser                       |
| `c`             | create issue                                       |
| `a`             | quick add to current column                        |
| `/`             | highlight loaded cards by key, title, or assignee  |
| `n` / `N`       | next / prev search match                           |
| `f`             | filter menu (assignee, type, sprint, label, epic)  |
| `s`             | toggle swimlane view (grouped lanes)               |
| `T`             | toggle Timeline view                               |
| `F`             | clear all filters                                  |
| `R`             | quick open — recents, or type to search all issues |
| `J`             | JQL query view                                     |
| `r`             | refresh                                            |
| `Ctrl+G`        | dismiss notifications                              |
| `?`             | help                                               |
| `q`             | back to board picker                               |

### Detail view

| Key             | Action                          |
| --------------- | ------------------------------- |
| `Tab`           | switch pane (body / fields)     |
| `↑ ↓ j k`       | scroll body / move field cursor |
| `g` / `G`       | top / bottom                    |
| `PgUp` / `PgDn` | page scroll                     |
| `Enter`         | edit field or open comment      |
| `x`             | clear optional field            |
| `[ ]`           | prev / next comment             |
| `c`             | add comment (editor)            |
| `C`             | create subtask                  |
| `e`             | edit title (inline)             |
| `E`             | edit description (editor)       |
| `t`             | transition to status            |
| `m`             | move to column                  |
| `w`             | toggle watch / unwatch          |
| `y` / `Y`       | copy issue key / URL            |
| `o`             | open in browser                 |
| `r`             | refresh                         |
| `Ctrl+G`        | dismiss notifications           |
| `Esc` / `q`     | close                           |

### Moving cards

Moves are optimistic. The card jumps to its destination immediately, dimmed with a `◴` while the transition POSTs in the background, then settles when Jira confirms — or snaps back with an error if it's rejected. Different cards move at once; a card mid-move is locked until it lands.

If the workflow requires fields, fill them in before the move. Unsupported required fields must be completed in Jira's web UI.

### Creating issues

`c` opens the create form. Choose an issue type, enter a title and any required description, then press `s`. Jira's extra required fields open in a separate field screen. Server defaults are kept. Unsupported required fields need Jira's web UI.

`a` uses the first standard issue type and asks for a title. If that type needs more fields, it opens the full form instead. After a quick add, ifhj tries to move the new issue to the selected column. A failed move or relationship reports the created issue key; the issue is still created.

From a loaded issue, `C` creates a subtask in that issue's project. Boards without a project location support browsing and issue actions, but board-level creation needs a project. Parent relationships are checked against available Jira hierarchy metadata.

### Swimlanes

When a board defines swimlanes, `s` groups it into horizontal lanes. Custom (JQL) lanes come from the board's own config, evaluated server-side; assignee, epic, issue-type, and parent lanes are grouped locally. Cards render one per line so several lanes fit on screen at once.

### Timeline

Press `T` from the flat board or swimlanes to open Timeline. Press `T` or `Esc` in the main Timeline to return to the same board representation. Esc on a flat or swimlane board does not open Timeline. Timeline uses the active board filters and highlight query. It keeps dated, undated, invalid, and off-window issues visible. Jira date-only values use UTC-day arithmetic, while Today uses your local calendar date.

A valid Start date through Due date is an inclusive range. A single known date is a point. Reversed ranges and invalid dates are not changed or guessed. If Start date metadata is unavailable or conflicting, Timeline says so instead of confirming that the issue is unscheduled. Valid scheduled rows sort by their first date, then issue key. All date-diagnostic rows follow, including rows that can still plot one known endpoint. Diagnostic rows with a usable endpoint sort by that date, then diagnostics without a usable endpoint sort by issue key. Confirmed Unscheduled rows are last and sort by issue key.

The ruler uses `S` for a Start-only point, `D` for a Due-only point, `=` for an inclusive range, `<` or `>` for clipped dates, `!` for a date problem, and `~` for an updating issue. `?` means Unscheduled after fresh data or unconfirmed while cached data waits for refresh. Today has its own `^` ruler marker.

The first Timeline window uses the selected issue when it has a usable date. For an interval, it uses Today when Today is inside the interval, or the nearest endpoint otherwise. If the selected issue has no usable date, Timeline chooses the nearest trustworthy interval or point. This includes a known Due date when Start metadata is unavailable or ambiguous. Cached rows with no dates remain unconfirmed until the fresh board load completes.

Month panning remembers the preferred day, so January 31 can move through February and return to January 31. Day or week pan, `0`, and `.` start a new date anchor. Wrong-typed Jira values appear as `Invalid Start date` or `Invalid Due date`; a trustworthy opposite endpoint remains plotted.

| Key             | Timeline action                               |
| --------------- | --------------------------------------------- |
| `← → h l`       | pan one calendar bucket                       |
| `↑ ↓ j k`       | select previous / next issue                  |
| `g` / `G`       | first / last issue                            |
| `PgUp` / `PgDn` | page issue rows                               |
| `+` / `=` / `-` | zoom in / out through Days, Weeks, and Months |
| `0`             | center Today                                  |
| `.`             | center the selected issue's usable date       |
| `Esc` / `T`     | return to the previous board representation   |
| `s`             | enter configured swimlanes                    |
| `v` / `Enter`   | issue detail / action menu                    |

The normal issue actions, filters, highlight navigation, create, refresh, quick open, JQL, browser, copy, and notification keys continue to target the current Timeline issue. Quick add, rank, and direct previous/next-column keys (`a`, `[ ]`, `< >`) are disabled because Timeline has no current column. Timeline does not drag, reschedule, or write dates. Press `v` to edit available date fields in issue details.

### Quick open

`R` opens a finder. Empty query lists recently-touched cards — anything you view or successfully act on (move, rerank, assign, edit, create). Recents persist per board and credential set across sessions at `~/.cache/ifhj/`. Type to search issue titles and exact keys across projects, up to 25 server results.

`J` opens the JQL view. Type a query and press Enter to search, up to 50 results. Use the Up/Down arrow keys to select a result, then Enter to open it. Editing the query clears the old results. Esc closes the view.

### Card order

Within a column, cards keep Jira's rank order — except finished-work columns (any status in Jira's "done" category, whatever the column is named), which sort newest-updated first so fresh completions don't get buried under stale rank.

### Editable fields

Jira's field metadata controls which fields can be edited. Supported fields include assignee, reporter, priority, story points, labels, components, fix versions, and due date. Tab to the fields pane, Enter to edit, `x` to clear an optional field. List fields let you add or remove selected values. Required fields cannot be cleared.

Parent fields with unsupported schemas stay read-only in detail view. Set the parent during issue creation instead.

### Custom fields

Project-specific custom fields from Jira's `editmeta` appear in the side panel. Supported option, user, text, number, date, and list fields are editable. Other types, including datetime and rich-text custom fields, remain read-only.

### Markdown

Descriptions and comments round-trip as Markdown. Write Markdown in the editor, it gets converted to Jira's ADF format on save. ADF from Jira gets converted back to Markdown for display.

Detail view loads the newest 100 comments, displayed in chronological order.

### @mentions

In a description or comment, type `@`. The editor opens a completion menu of the project's assignable users — pick one and it inserts `[@Name](jira-mention:<id>)`. On save, that becomes a real Jira mention.

Plain `@foo` that you type yourself stays as literal text. The mention is whatever came out of the menu — no guessing.

The completion source is injected via `--cmd` / `-c` and is buffer-local, so it doesn't touch your regular Neovim/Vim config. (It's classic vimscript, so it works in both.)

### Stats

Each column header shows the card count, the sum of estimates when non-zero, and — if the board config sets a WIP limit — `count/max`, red when over. Estimates use the board's configured numeric estimation field, with story-point discovery as a fallback. Original Time Estimate is shown in hours, minutes, and seconds; point estimates use `p`. The board header rolls up the visible-issue total.

### Caching

Board state is cached at `~/.cache/ifhj/` and painted instantly on open, whatever its age. Cache files are separate for each server and credential set. Their names contain short hashes, never raw credentials. Fresh data loads in the background and replaces the cache when Jira responds. Failed refreshes keep the last loaded board visible.

## Development

```sh
bun install
bun run dev            # hot reload
bun test               # tests
bun run check          # formatting + lint + types + tests
bun run format:check   # formatting check
bun run format         # apply formatting
bun run lint           # oxlint + tsc
bun run compile        # native binary
```

### Cutting a release

```sh
./scripts/release.ts patch  # or: minor | major | 1.2.3
```

Requires a clean worktree and a new version. Installs locked dependencies, checks formatting, lint, types, tests, and compilation, then bumps the version, commits, tags, and pushes the branch and tag together. GitHub Actions checks the tag/version match and cross-compiles for darwin/linux x amd64/arm64.

## Author

[@therealparmesh](https://github.com/therealparmesh)

## License

MIT
