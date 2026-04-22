# ifhj

**i freaking have jira** — a fast, keyboard-driven TUI for Jira. If I have to live inside a board all day I'd rather not do it in a browser tab.

Pick a board, arrow-key around, open issues, edit summaries and descriptions in Neovim, transition cards across columns, create new issues from a form, search, filter by assignee, open anything in the browser when you actually need the web view.

## Install

### mise (recommended)

Pulls a prebuilt binary straight from GitHub releases.

```sh
mise use -g github:therealparmesh/ifhj
```

### Download the binary

Grab the tarball for your OS/arch from the [latest release](https://github.com/therealparmesh/ifhj/releases), extract, drop on `$PATH`. Each release has a `checksums.txt` covering every asset.

Assets are named `ifhj_<version>_<darwin|linux>_<amd64|arm64>.tar.gz`.

### From source

Needs [bun](https://bun.sh) ≥ 1.3.

```sh
git clone https://github.com/therealparmesh/ifhj
cd ifhj
bun install
bun run compile
mv ifhj /usr/local/bin/
```

## Prerequisites

### Neovim

ifhj shells out to `nvim` for every text edit (title, description, create). It's assumed to be on `$PATH`.

```sh
# macOS
brew install neovim

# Debian / Ubuntu
apt install neovim

# Arch
pacman -S neovim
```

### Jira API token

Generate one at <https://id.atlassian.com/manage-profile/security/api-tokens>. You'll need it exported as `JIRA_API_TOKEN`.

### Configuration

ifhj reads configuration from environment variables first, then from `~/.config/.jira/.config.yml` (the [jira-cli](https://github.com/ankitpokhrel/jira-cli) default — if you already use that CLI, ifhj picks up its configuration for free).

**Environment variables:**

```sh
export JIRA_SERVER="https://your-company.atlassian.net"
export JIRA_LOGIN="you@your-company.com"    # or JIRA_EMAIL
export JIRA_API_TOKEN="<token>"
```

**Or `~/.config/.jira/.config.yml`:**

```yaml
server: https://your-company.atlassian.net
login: you@your-company.com
```

(token still comes from `JIRA_API_TOKEN` — it doesn't live in the yaml.)

## Usage

```sh
ifhj
```

You'll get a board picker. Pick one. From there, everything's keyboard.

## Keybindings

### Board view

| Key       | Action                                                    |
| --------- | --------------------------------------------------------- |
| ↑ ↓ ← →   | move cursor (up/down within col, left/right between cols) |
| ⏎         | open card action menu                                     |
| v         | view full issue details                                   |
| m         | move card to any column (picker)                          |
| `<` / `>` | transition to prev / next column                          |
| e / E     | edit summary / description in Neovim                      |
| c         | create a new issue (form)                                 |
| o / O     | open current card / board in browser                      |
| /         | search                                                    |
| n / N     | next / prev match                                         |
| a / A     | filter by assignee / clear filter                         |
| r         | refresh                                                   |
| ?         | help                                                      |
| q         | back to board picker                                      |
| ⌃c        | exit                                                      |

### Detail modal

| Key       | Action                   |
| --------- | ------------------------ |
| ↑ ↓ / j k | scroll                   |
| g / G     | top / end                |
| PgUp/PgDn | page up / down           |
| e / E     | edit title / description |
| o         | open in browser          |
| esc / q   | close                    |

### Create form

| Key       | Action                                   |
| --------- | ---------------------------------------- |
| ↑ ↓ / j k | move between fields                      |
| ⏎         | edit focused field (Neovim or picker)    |
| s         | submit (when required fields are filled) |
| esc       | cancel                                   |

### Any picker (card-action, assignee, type, relationship, target)

| Key | Action           |
| --- | ---------------- |
| ↑ ↓ | nav              |
| ⏎   | pick             |
| ⌃x  | clear (assignee) |
| esc | cancel           |

## How comments work

ifhj shows comments on the detail view (`v` on a card) in chronological order with a thin divider between each one.

**No threading.** Jira Cloud's `/rest/api/3/issue/{key}/comment` endpoint on Software/Agile boards returns a flat list — Jira's "reply to a comment" feature in the web UI is an ADF/`@mention` convention, not structured in the REST response. Service Desk tickets have threading fields but that's a different product. So: flat, oldest-first, read-only for now.

## Development

```sh
bun install
bun run dev            # hot reload
bun run lint           # oxfmt + oxlint + tsc
bun run compile        # native binary for this host
```

### Cutting a release

```sh
./scripts/release.ts patch  # or: minor | major | 1.2.3
```

Runs from anywhere in the repo. Bumps `package.json`, resyncs `bun.lock`, commits, tags `vX.Y.Z`, pushes. The `release` workflow cross-compiles binaries for darwin/linux × amd64/arm64, tars them with SHA-256 checksums, and publishes a GitHub Release.

First release only: the `release` workflow has to be on the default branch before the tag push, or there's nothing to trigger. Push to `main` first, then cut.

## Troubleshooting

**"Missing Jira server" / "Missing Jira login email" / "Missing JIRA_API_TOKEN"** — you haven't set up the configuration. See [Prerequisites](#prerequisites).

**401 Unauthorized on every request** — your token is wrong, expired, or your login email doesn't match the account the token was issued for.

**Neovim doesn't open** — ifhj assumes `nvim` is on `$PATH`. Install it (see [Prerequisites](#prerequisites)). If you prefer a different editor, file an issue — I'd consider supporting `$EDITOR` if there's demand.

**The "Open Board" shortcut (`O`) 404s** — ifhj uses the team-managed project URL. Classic / RapidBoard projects use a different path; Jira usually redirects in-browser anyway. File an issue with your project style if it's broken.

**Custom fields aren't showing up** — ifhj assumes the Jira Cloud defaults: `customfield_10014` (Epic Link), `customfield_10020` (Sprint), `customfield_10016` (Story Points). If your tenant remapped those, file an issue.

## Author

[@therealparmesh](https://github.com/therealparmesh)

## License

MIT
