# Filesystem MCP Server — Home Assistant App (Add-on)

Home Assistant app that exposes a local directory as an MCP (Model Context Protocol) server. Allows LLM agents like Claude to read and write files directly on your Home Assistant server.

## What is MCP?

[Model Context Protocol](https://modelcontextprotocol.io) is an open standard that allows AI assistants to connect to external tools and data sources. This app lets Claude (or any MCP-compatible agent) read and write files in a directory on your HA server — useful for building a personal knowledge base, wiki, or any file-based workflow.

## Features

- Exposes a local directory (e.g. `/media/VAULT` or `/share/vault`) via MCP over HTTP (StreamableHTTP transport)
- Multi-arch: amd64, aarch64 (Raspberry Pi 4/5)
- Token-based auth via URL prefix (`/private_<token>/`)
- Compatible with [claude.ai](https://claude.ai) custom connectors
- Configurable vault path — both `/media` and `/share` are mapped read-write
- Creates the vault skeleton and `CLAUDE.md` **once**, on a fresh install — a directory you delete afterwards stays deleted
- **Content search** — `grep_files` finds text by regex across the tree and returns file, line number and the matching line, clipped around the match
- **Line-addressed reading and editing** — `read_text_file` takes `offset`/`limit`, `edit_file` takes `startLine`/`endLine`, guarded by a `rev` optimistic lock
- PDF reading support — page images (JPEG) via `read_media_file` (`#N` suffix) and `read_pdf_page`, cheap text extraction via `read_pdf_text` (pdftotext)
- **Write policies** — mark a directory read-only, or require a file's current `rev` before anything overwrites it; a trash instead of a delete, with optional auto-purge. Off by default, configured from an ingress page in the HA sidebar
- Optional request logging (`log_requests`) for debugging connector issues — see [Request logging](#request-logging-debugging)

## Community

💬 [Discussion thread on Home Assistant Community Forum](https://community.home-assistant.io/t/filesystem-mcp-server-expose-your-local-directory-to-claude-karpathy-llm-wiki-for-home-assistant/)

## Architecture support

| Architecture | Status |
|--------------|--------|
| amd64 | ✅ Tested (x86-64 servers and mini PCs) |
| aarch64 | ✅ Tested (Raspberry Pi 4, HA OS 2026.5.x — community-confirmed in [#1](https://github.com/st412m/ha-filesystem-mcp/issues/1)) |

`armv7` was dropped in 2.4.1: Home Assistant Supervisor deprecated the architecture and warned on every install.

## Where to put your vault

Two options, pick the one that fits your hardware:

### Option A: External USB drive at `/media/VAULT` (recommended for dedicated storage)

#### 1. Format the drive as ext4

Connect your USB drive to the HA server. Open the Terminal app in HA and find the drive:

```bash
lsblk
```

Your drive will appear as `sdb`, `sdc`, or similar — the name depends on your system. Format it with ext4 and label it `VAULT`:

> ⚠️ This will erase all data on the drive. Replace `sdb` with your actual device name.

```bash
mkfs.ext4 -L VAULT /dev/sdb
```

#### 2. Install the Samba NAS app for auto-mounting

The [Samba NAS app](https://github.com/dianlight/hassio-addons) handles automatic mounting of the drive at every HA startup.

1. Add the repository in **Settings → Apps → App Store → ⋮ → Repositories → + Add**:
   ```
   https://github.com/dianlight/hassio-addons
   ```
2. Install **Samba NAS** and start it

After the app starts, your drive will be available at `/media/VAULT/` and will remount automatically on every reboot. You can verify in **Settings → System → Storage**.

### Option B: Built-in `/share` storage (no USB drive needed)

If the USB route is more friction than it's worth on your hardware (common on Raspberry Pi), you can keep the vault on HA's internal `/share` storage instead — no formatting, no extra apps:

```yaml
vault_path: "/share/vault"
```

The app maps both `/media` and `/share` read-write, so any path under either works. Keep in mind that `/share` lives on the same disk/SD card as HA itself — for an SD-card Pi setup, consider regular backups of the vault.

## Installation

> **A note on wording.** Home Assistant renamed **add-ons** to **apps** in 2026.2 (February 2026) — the UI and the docs changed, nothing else did. `config.yaml`, `repository.yaml`, the store layout and the Supervisor API still say *add-on*, which is why the repository is still named `ha-filesystem-mcp`. The click paths in this README are for 2026.2 and newer; on an older core the same two places are called *Add-ons* and *Add-on Store*.

**1. Add this repository**

[![Open your Home Assistant instance and show the add app repository dialog with a specific repository URL pre-filled.](https://my.home-assistant.io/badges/supervisor_add_addon_repository.svg)](https://my.home-assistant.io/redirect/supervisor_add_addon_repository/?repository_url=https%3A%2F%2Fgithub.com%2Fst412m%2Fha-filesystem-mcp)

Or by hand: **Settings → Apps → App Store → ⋮ → Repositories → + Add**, paste `https://github.com/st412m/ha-filesystem-mcp`, select **Add**.

*If the badge opens the App Store but no dialog appears, that is [my.home-assistant.io#698](https://github.com/home-assistant/my.home-assistant.io/issues/698), open since April 2026 — use the manual path above.*

**2. Install**

Find the **Filesystem MCP Server** card in the new repository, select **Install**, set a `token` and `vault_path` in Configuration, then **Start**.

## Configuration

| Option | Description |
|--------|-------------|
| `token` | Secret token for auth. Generate with `cat /proc/sys/kernel/random/uuid` in HA terminal. Change from the default `changeme`! |
| `vault_path` | Path to expose via MCP — anywhere under `/media` or `/share` (default: `/media/VAULT`) |
| `log_requests` | Log every incoming request to the app log (default: `false`). See [Request logging](#request-logging-debugging) |

Example:
```yaml
token: "your-uuid-here"
vault_path: "/media/VAULT"
log_requests: false
```

## Request logging (debugging)

When diagnosing connector problems — especially "claude.ai shows zero tools but curl works" — the key question is usually *did claude.ai's fetcher even reach my server?* Set `log_requests: true` in the app configuration and restart the app; the auth proxy will then log one line per incoming request:

```
[req] 2026-07-13T10:56:25.478Z 160.79.106.34 POST /private_***/mcp -> 200 172B ua="Claude-User"
```

Fields: timestamp, client IP (`CF-Connecting-IP`, falling back to `X-Forwarded-For`, then socket address), method, path, response status, response size, User-Agent. The secret token is always masked (`/private_***`), and unauthorized (401) probes are logged too. With the default `false` the proxy logs nothing, exactly as before.

Watch the log during a registration attempt: requests from Anthropic's published egress range (`160.79.104.0/21`) getting answered `200` mean the path works end to end; total silence means the requests never reached you — look upstream (tunnel, edge, or claude.ai itself). See the investigation in [#4](https://github.com/st412m/ha-filesystem-mcp/issues/4) for a worked example.

## What happens on first run

The app automatically creates the following structure inside your vault if it doesn't exist yet:

```
/media/VAULT/
├── CLAUDE.md        # agent instructions (Karpathy wiki pattern)
├── log.md           # operation log
├── raw/             # drop your source files here
│   ├── ha/
│   └── projects/
└── wiki/            # LLM-compiled pages
    ├── ha/
    │   ├── devices/
    │   ├── automations/
    │   └── network/
    └── projects/
```

Since 2.6.0 this happens **once**, on a fresh install, and is remembered with a flag in `/data`. Delete a directory afterwards and it stays deleted. Until 2.6.0 six `mkdir -p` ran on every start, so removing `raw/projects` lasted only until the next restart — the guard was on the files, not on the directories. Upgrading an existing installation (detected by the presence of `CLAUDE.md`) never re-creates anything, and `CLAUDE.md` and `log.md` are never overwritten.

You can drop files into `raw/` via the Samba share (`\\<your-ha-ip>\VAULT`) from Windows, or via SFTP.

> **Note on `CLAUDE.md`:** The auto-generated `CLAUDE.md` is just a starting point — a minimal template with basic instructions and vault structure. You are expected to customize it over time: add your device inventory, network topology, project context, MCP server constraints, and any rules specific to your setup. The more context you put in `CLAUDE.md`, the more useful Claude becomes across sessions. Think of it as a living document that grows with your smart home.

## Exposing externally (required for claude.ai)

To connect from claude.ai you need to expose port 3100 via your router.

For Keenetic routers:
1. **Port forwarding** — **Network rules → Port forwarding → Add rule**: incoming port `3100` → your HA server IP, port `3100`
2. **Domain** — **My networks and Wi-Fi → Domain name → Add**: name `vault-mcp`, device → your HA server, port `3100`

## Connecting to Claude

Your MCP endpoint will be:

```
https://vault-mcp.yourdomain.keenetic.link/private_<your-token>/mcp
```

Add this URL in **claude.ai → Settings → Connectors → Add custom connector**.

## Write policies

By default there are none and the app behaves as it always has: any tool may write anywhere in the vault. Strictness is opt-in, per directory, from the **Vault policies** page that 2.6.0 adds to the Home Assistant sidebar (ingress, admins only).

A policy is a JSON file named `.vault-policy` that the page writes into a directory. It applies to that directory and everything below it, until a deeper marker overrides it; fields the deeper marker does not mention keep the inherited value.

| Mode | Effect |
|------|--------|
| inherits | no marker here — the rule from above applies |
| read-only | no writes, edits, moves in or out, or discards. Reading is unaffected |
| edits with rev | creating a new file is free; changing or moving out an **existing** file requires its current `rev` |
| free writes | 2.5.x behaviour, no checks |
| new files only | existing files may not be changed at all |

The `rev` is the same short content hash used by `edit_file`, and it is already in hand in normal work — it comes back from `grep_files`, from `read_text_file` with `offset`, from `get_file_info`, and in the reply to the previous edit. A refusal always quotes the current one, so the retry succeeds.

There is no delete. `trash_file` moves a file into its zone's trash (`.vault-trash` by default), keeping the path relative to the directory that owns the trash and stamping the arrival time into the name — `wiki/system/foo.md` becomes `wiki/.vault-trash/system/foo__trash-20260905T050121Z.md`. The stamp is there because a move does not change mtime: without it, a page that had lived in the wiki for six months would look ancient the moment it was discarded. Trash contents are excluded from `grep_files`, `search_files`, `directory_tree` and `read_multiple_files`, so a thrown-away version stops turning up in searches and being quoted as if it were current; an explicit `read_text_file` still opens it.

Auto-purge is per zone and **off by default**. It removes files one at a time and empty directories with `rmdir` — there is no recursive delete anywhere in this app — and it never touches a file whose name carries no arrival stamp, on the assumption you put it there by hand. Before switching it on, check how your vault is backed up: if the backup is a mirror (`rsync --delete`, no `--backup-dir`), a purge here disappears from the backup at its next run.

A corrupt marker, or one carrying an unknown field, **locks its zone**: no writes, no deletion, reading unaffected. Deliberately so — carrying on quietly under a rule nobody can read is worse than a stop you can see. The error names the file. MCP tools also refuse to create, change, move or discard anything named `.vault-policy`, `create_directory` included: a *directory* with that name would make the marker unreadable and lock the zone permanently from the tool side.

**Read-only stops this app's tools and nothing else.** Anything else writing into the vault — a Home Assistant `shell_command` copying files in, Samba, the file editor — goes straight to the filesystem and never sees a marker.

## Finding and editing things without reading whole files

Before 2.5.0 an agent could search file *names* (`search_files`) but not file *contents*, and could read only from an edge of a file (`head`/`tail`). Finding one line in the middle of a large page meant pulling half the page into the context window. 2.5.0 closes that: `grep_files` returns addresses, and those addresses are directly usable by `read_text_file` and `edit_file`.

### The loop

```
grep_files  path=/media/VAULT/wiki  pattern="blacklist-testing"  include=*.md
  → /media/VAULT/wiki/todo.md · rev 5db20d56 · 566 lines
      363: - [ ] Проверка черных списков (ЧС) — pet-проект …

read_text_file  path=…/todo.md  offset=358  limit=15
  → …/todo.md · rev 5db20d56 · lines 358-372 of 566

edit_file  path=…/todo.md  rev=5db20d56  edits=[{startLine:363, newText:"- [x] …"}]
  → lines 566 → 566 · rev 5db20d56 → c31af9e1
```

Every step carries the same `rev` — an 8-hex digest of the file. `edit_file` refuses a line edit whose `rev` no longer matches and writes nothing, so a stale line number can never quietly land in the wrong place. `rev` also comes back from `get_file_info`, alongside a line count.

### What this costs and what it saves

The tool list is sent to the model on every session, whether or not the tools are called, so new tools are a standing tax. Measured on the real `tools/list` payload:

| | tools | `tools/list` bytes |
|---|---|---|
| 2.4.1 | 16 | 4 277 |
| 2.5.0 | 17 | 5 630 |

That is **+1 353 bytes ≈ +350 tokens per session**, and it is deliberately smaller than the raw cost of the new features: existing descriptions were compressed in the same release to pay for part of it, and line-range reading was added as two parameters on `read_text_file` rather than as a separate `read_lines` tool.

Against that, one real lookup from the author's wiki — locating a single stale entry in a 185 KB / 566-line `todo.md`:

| | approach | tokens pulled into context |
|---|---|---|
| 2.4.1 | `read_text_file head=400` (line 363 is past the middle) | ≈ 35 000 |
| 2.5.0 | `grep_files` → 1 file, 1 line + footer | ≈ 60 |

Break-even is roughly one search per hundred sessions. The defaults are set for economy rather than completeness — `max_results` 50, `context` 0, `max_line_length` 200 — because a tool that dumps everything by default costs the same as reading everything.

### Behaviour worth knowing

- **Long lines are clipped around the match, not from the start.** With multi-KB lines a head-clip would routinely hide the very text that matched. `max_line_length` defaults to 200 characters.
- **Truncation is always announced.** The answer is capped at 60 KB as well as at `max_results`; when either bites, the reply carries an explicit `⚠ TRUNCATED` line. Silently returning a partial list would be worse than returning nothing.
- **Skipped by design:** binary files (NUL byte in the first 4 KB), files over 20 MB, symlinks, and `.git` / `node_modules` / `.svn` / `.hg` directories. Counts of skipped files appear in the footer.
- **`include` / `exclude`** are filename globs matched against the basename, with comma-separated alternatives: `include="*.md,*.yaml"`.
- **Line edits are applied bottom-up in one atomic pass**, so several edits from a single `grep_files` result stay valid within one call. Overlapping ranges are rejected. `newText: ""` deletes the range; `newText` must not end with a newline unless a blank line is wanted. Two inserts at the same position are rejected (bottom-up they would collapse and swap), as is an insert landing inside a range replaced by the same call. `newText: ""` at an insert position is an error — there is nothing there to delete.
- **Omitting `endLine` inserts before `startLine`; replacing requires an explicit `endLine`** (since 2.5.2). `{startLine: 50, newText: "..."}` inserts a line before line 50, and on a 12-line file `{startLine: 13, ...}` appends at EOF — appending is the same insert landing at the end, not a special case. Appending to an empty file is `startLine: 1`. `rev` is required exactly as for any other line edit; `startLine` beyond `lines`+1 and an explicit `endLine` past the last line are both errors, each naming the form you probably wanted. In 2.5.1 a missing `endLine` silently meant *replace line `startLine`* anywhere except EOF, so an append aimed one line short overwrote a line instead of adding one.
- **`head` / `tail` count the same lines as everything else** (since 2.5.1). Before that, `tail=N` on a file ending with a newline returned N−1 lines.
- **CRLF, BOM and a missing final newline are preserved** by line edits.
- `oldText`/`newText` edits are unchanged and still work without `rev`.

### ⚠️ After updating: start a new chat

MCP clients cache `tools/list` for the lifetime of a conversation, so a chat that was already open keeps the tool list it started with. On 2.5.0 that meant `grep_files` appeared only in a **new** conversation; on 2.5.1 and 2.5.2, where no tools were added, only the *description* of `edit_file` changed — the behaviour itself is not cached, so an already-open chat gets the new semantics while still reading the old description.

## Recommended companion apps

For the full Karpathy LLM wiki experience, also install:

- **[HA-MCP](https://github.com/homeassistant-ai/ha-mcp)** — gives Claude access to your Home Assistant entities, automations, and devices. Together with Filesystem MCP, Claude can read your HA state and write structured wiki pages about it.
- **Keenetic MCP** — if you use a Keenetic router, gives Claude access to network clients, DHCP, Wi-Fi, and VPN status.

## Security

- The token is embedded in the URL path — this is intentional, as claude.ai does not support custom auth headers for MCP connectors
- Never expose port 3100 to the internet without HTTPS
- Change the default token `changeme` before exposing externally
- Use a randomly generated UUID as your token
- Every path is confined to `vault_path`. Since 2.5.0 this also covers symlinks pointing out of the vault and sibling directories that merely share the name prefix (`/media/VAULT_backup` no longer passes for `/media/VAULT`)
- `grep_files` runs in a short-lived child process with a 10-second hard kill, so a catastrophically backtracking regex cannot wedge the server
- Since 2.6.0 the auth proxy forwards **only** `/mcp`; every other path answers 404 before reaching the server. Until then it cut the token prefix off and passed whatever was left through, so every route the server had was published — which is how `POST /write`, an unauthenticated whole-file overwrite, was reachable from the internet
- The policy page runs as a separate process on a separate internal port and is reachable only through Home Assistant ingress, which authenticates the user itself. It is not reachable through the token URL, and the MCP dispatcher holds no reference to the function that writes markers

## Architecture

```
Claude (claude.ai)
    ↓ HTTPS
Reverse proxy (Keenetic / nginx / Cloudflare Tunnel)
    ↓ HTTP :3100
proxy.js (token auth, /mcp only, optional request logging)
    ↓ HTTP :3099
server.js (MCP StreamableHTTP)
    ↓
/media/VAULT/ (your files)
    ↑
policy-ui.js (:3101, ingress only, writes .vault-policy)
    ↑ HTTP, 172.30.32.2 only
Home Assistant sidebar → "Vault policies"
```

## Changelog

- **2.6.0** — write policies. A `.vault-policy` marker makes a directory and everything below it read-only, or requires a file's current `rev` before an existing file is overwritten or moved out, or allows only new files; markers are written solely from a new ingress page in the HA sidebar, and the MCP tools refuse to create, change, move or discard one (`create_directory` included — a *directory* of that name would lock the zone with no way to repair it from the tool side). New `trash_file` replaces deletion: the file moves into its zone's trash keeping its relative path, with the arrival time stamped into the name, and trash contents drop out of `grep_files`, `search_files`, `directory_tree` and `read_multiple_files`. Optional per-zone auto-purge, **off by default**, removes files one at a time, never recursively, and never touches a file without an arrival stamp. `write_file` and `move_file` accept `rev`; every refusal quotes the current one. The three listing tools now print the rule in force and where it comes from on every call. A corrupt or unknown-field marker fails **closed** — no writes, no deletion, reading unaffected. **Removed: `POST /write`** — an unauthenticated whole-file overwrite that the blind prefix proxy published to the internet, making any policy below it bypassable with one `curl`; there is no replacement, and any `rest_command` using it must be removed. The proxy now forwards only `/mcp`. **Changed:** the vault skeleton is created once on a fresh install instead of on every start, so a deleted directory no longer comes back. **Not breaking:** a vault with no markers behaves exactly as in 2.5.2, and `read_text_file` without a range still returns the bare file contents byte for byte
- **2.5.2** — one behaviour fix, no new tools and no schema changes. **Omitting `endLine` now inserts before `startLine` instead of silently replacing that line.** 2.5.1 made `{startLine: lines+1}` with no `endLine` an append at EOF, but at any other line the same shape still meant *replace line `startLine`*, because `endLine` defaulted to `startLine` — one shape with two meanings, selected by a number the caller had to compute correctly first. An append aimed one line short did not fail; it quietly overwrote a line, which is the exact silent corruption line addressing exists to prevent. Found during acceptance testing of 2.5.1. Appending is now the same insert landing at the end rather than a special case, and inserting into the middle of a file — previously impossible, and worked around with `oldText` against a hand-copied line — is a normal call. Replacing requires an explicit `endLine`. New refusals: `startLine` beyond `lines`+1 (naming the last valid insert position), two inserts at the same position in one call, and an insert falling inside a range replaced by the same call. `rev` remains mandatory, `newText: ""` at an insert position is an error, CRLF/BOM/missing final newline are preserved, and `oldText` edits are untouched. **Breaking:** `{startLine: N, newText: "..."}` with no `endLine` used to replace line N and now inserts before it; the shorthand was undocumented and shipped only in 2.5.1. `tools/list` 5,682 → 5,741 bytes
- **2.5.1** — two fixes from acceptance testing of 2.5.0, no new tools and no schema changes. **`tail=N` returned N−1 lines** on any file ending with a newline — that is, on almost every file: the `head`/`tail` branch sliced a raw `split('\n')`, in which a trailing newline leaves a phantom empty element at the end. It now slices the same line array as `offset`/`limit` and `get_file_info`, so `tail=N` and a `lines` count of N agree. The bug predates 2.5.0; the `lines` field added in 2.5.0 is simply what made it visible. `head` was never affected and its output is unchanged. **Appending by line number is now possible:** `{startLine: lines+1}` with no `endLine` inserts at the end of the file instead of failing with *endLine is past the end of the file*. It is an empty range at EOF, not a new parameter — an explicit `endLine` past the end is still refused (with a hint), `rev` is still mandatory, `newText: ""` at the append position is an error rather than a silent no-op, and two appends in one call are refused instead of being silently reordered by the bottom-up pass. CRLF, BOM and a missing final newline are preserved as before
- **2.5.0** — content search and line-addressed editing. New `grep_files` (regex, recursive, `include`/`exclude` globs, `context`, `max_results`, `max_line_length` — long lines are clipped *around* the match; binaries, symlinks and `.git`/`node_modules` skipped; output capped at 60 KB with an explicit truncation warning; runs in a forked child with a 10 s hard kill so a catastrophically backtracking regex cannot hang the server). `read_text_file` gains `offset`/`limit` for arbitrary line ranges; `edit_file` gains `{startLine,endLine,newText}` edits protected by a `rev` optimistic lock and applied bottom-up in one atomic pass; `get_file_info` now reports `lines` and `rev` for text files. Path confinement hardened: symlinks escaping the vault are refused, and a sibling directory sharing the name prefix no longer passes the check. Existing tool descriptions were compressed to offset part of the added `tools/list` payload. No option, port or storage-format changes; all existing tool signatures and outputs are unchanged
- **2.4.1** — dropped `armv7`: Home Assistant Supervisor deprecated the architecture and printed a warning on every install. No functional change on amd64/aarch64 — the whole diff is the `arch` list in `config.yaml`, the `io.hass.arch` label in the Dockerfile, and the architecture table above
- **2.4.0** — migrate off deprecated `build.yaml`: base image is now set in the Dockerfile as the arch-less multi-arch manifest `ghcr.io/home-assistant/base:3.22` (buildx resolves the platform — no silent wrong-arch fallback); toolchain moves to Alpine 3.22 (nodejs 20→22, poppler 24→25), guarded by a build-time major-version check plus a smoke test of the real PDF pipeline (`pdfinfo`/`pdftoppm`/`pdftotext` on a generated reference PDF); toolchain versions and build manifest are printed to the addon log on start; addon version now flows from `config.yaml` → `BUILD_VERSION` → `ADDON_VERSION` (no more hardcoded versions in `server.js`/`run.sh`); dropped unused `npm` from the image
- **2.3.2** — new `log_requests` option: opt-in request logging in the auth proxy (client IP, method, token-masked path, status, response size, User-Agent; 401 probes included) for debugging connector issues ([#4](https://github.com/st412m/ha-filesystem-mcp/issues/4)); no behavior changes with default settings
- **2.3.1** — GET `/mcp` now returns `405 Method Not Allowed` per the MCP Streamable HTTP spec instead of holding a dead SSE stream open (hung clients ~30s even on LAN, broke tool registration through buffering proxies like Cloudflare Tunnel); POST `/mcp` responds with plain `application/json` instead of a single-event SSE — immune to tunnel SSE buffering that could truncate large base64 payloads ([#4](https://github.com/st412m/ha-filesystem-mcp/issues/4))
- **2.3.0** — new `read_pdf_text` tool (pdftotext with layout preservation, optional page range); removed non-spec `structuredContent` duplication from all tool responses — roughly halves the payload for media results ([#3](https://github.com/st412m/ha-filesystem-mcp/issues/3)); `read_media_file` now actually returns the total PDF page count as documented; removed dead SVG rendering path (`read_pdf_page` always returned JPEG since 2.0.0)
- **2.2.2** — fix `TypeError` when MCP clients (claude.ai) serialize array parameters as JSON strings — affected `edit_file`, `read_multiple_files`, `search_files` ([#2](https://github.com/st412m/ha-filesystem-mcp/issues/2))
- **2.2.1** — multi-arch support (amd64/aarch64/armv7) via `build.yaml`; `share:rw` mapping so `vault_path` can live under `/share`; fixes build failure on Supervisor 2026.04+ ([#1](https://github.com/st412m/ha-filesystem-mcp/issues/1))
- **2.1.0** — `POST /write` endpoint for HA automations *(removed in 2.6.0)*
- **2.0.0** — custom HTTP MCP server (StreamableHTTP), supergateway removed; PDF page reading

## License

MIT
