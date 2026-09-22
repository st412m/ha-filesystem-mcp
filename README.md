# Filesystem MCP Server — Home Assistant App (Add-on)

A Home Assistant app that exposes one directory on your Home Assistant server — a "vault" — as a [Model Context Protocol](https://modelcontextprotocol.io) server. Claude or any other MCP client can read, search and edit files there, read PDFs, and query SQLite databases read-only. It is built for a file-based knowledge base such as a Karpathy-style LLM wiki, but works for any directory tree.

Home Assistant's built-in MCP Server integration exposes entities and Assist. This app exposes files instead, and the two work side by side.

The transport is MCP Streamable HTTP: `POST /mcp` answered with plain `application/json`. There is one endpoint, published on port 3100.

Authorization is a secret path prefix, `/private_<token>`, because claude.ai custom connectors cannot send custom auth headers. Anyone holding the URL has full access to the vault, so treat it as a password.

## Requirements

| | |
|---|---|
| Home Assistant | OS or Supervised — anything that runs apps (add-ons) through Supervisor |
| Architecture | amd64, aarch64 (Raspberry Pi 4/5) |
| Network | port 3100/tcp; for claude.ai, a TLS reverse proxy reachable from the internet |
| Storage | a directory under `/media` (e.g. a USB drive) or `/share` — see [docs/configuration.md](docs/configuration.md) |

## Installation

Home Assistant renamed *add-ons* to *apps* in 2026.2; on older versions the same menus say *Add-ons* and *Add-on Store*.

**1. Add this repository**

[![Open your Home Assistant instance and show the add app repository dialog with a specific repository URL pre-filled.](https://my.home-assistant.io/badges/supervisor_add_addon_repository.svg)](https://my.home-assistant.io/redirect/supervisor_add_addon_repository/?repository_url=https%3A%2F%2Fgithub.com%2Fst412m%2Fha-filesystem-mcp)

Or by hand: **Settings → Apps → App Store → ⋮ → Repositories → + Add**, paste `https://github.com/st412m/ha-filesystem-mcp`, select **Add**.

*If the badge opens the App Store but no dialog appears, that is [my.home-assistant.io#698](https://github.com/home-assistant/my.home-assistant.io/issues/698) — use the manual path.*

**2. Install and configure**

Find **Filesystem MCP Server** in the store and select **Install**. In **Configuration**, set `token` to a random secret — `cat /proc/sys/kernel/random/uuid` in the HA terminal gives one — and point `vault_path` at your vault.

**3. Start**

Select **Start**. On a fresh install the app creates a starter `CLAUDE.md`, `log.md` and a small `raw/` + `wiki/` skeleton inside the vault, once. The app log shows the toolchain versions, the vault path and the three processes starting.

## Configuration

| Option | Default | Description |
|---|---|---|
| `token` | `changeme` | Secret in the URL path. Change it before exposing the port. |
| `vault_path` | `/media/VAULT` | The one directory the server may touch — anywhere under `/media` or `/share`. |
| `log_requests` | `false` | Log one line per incoming request (token masked) for debugging connectors. |

```yaml
token: "your-uuid-here"
vault_path: "/media/VAULT"
log_requests: false
```

Choosing and preparing the vault location, the first-run skeleton and request logging are covered in [docs/configuration.md](docs/configuration.md).

## Connecting to claude.ai

The endpoint is:

```
https://<your-host>/private_<your-token>/mcp
```

Add it in **claude.ai → Settings → Connectors → Add custom connector**.

claude.ai reaches the server from the internet, so port 3100 must be published through a reverse proxy that terminates TLS — your router's own domain service, nginx, a Cloudflare Tunnel. Do not publish plain HTTP. The app itself only answers `/mcp` under the token prefix: a wrong prefix gets 401, any other path 404. A Keenetic example is in [docs/configuration.md](docs/configuration.md#exposing-the-server).

## Tools

20 tools. Parameters, return formats and the differences between similar tools are in [docs/tools.md](docs/tools.md).

**Reading**
- `read_text_file` — a whole text file, `head`/`tail` lines, or an `offset`/`limit` range with line count and `rev`
- `read_file` — deprecated alias of `read_text_file`
- `read_multiple_files` — several whole files in one response
- `read_media_file` — image or audio as base64; a PDF page as JPEG (`#N` suffix on the path)
- `read_pdf_text` — text of a PDF or a page range, via `pdftotext -layout`
- `read_pdf_page` — one PDF page rendered as JPEG

**Searching**
- `grep_files` — regex search of file contents; returns path, `rev`, line count and matching lines
- `search_files` — find files and directories by name substring

**Writing**
- `write_file` — create or overwrite a file
- `edit_file` — literal `oldText` replacement, or line-addressed edits guarded by `rev`
- `create_directory` — create a directory and its parents
- `move_file` — move or rename a file or directory
- `trash_file` — move a file into its zone's trash; there is no delete

**Listing**
- `list_directory` — entries of one directory
- `list_directory_with_sizes` — entries with file sizes, sorted by name or size
- `directory_tree` — tree view, two levels deep
- `get_file_info` — size and times, plus line count and `rev` for text files
- `list_allowed_directories` — the vault root

**SQLite (read-only)**
- `sqlite_schema` — DDL of every object, file pragmas, optional per-table row counts
- `sqlite_query` — one `SELECT`/`WITH`/`VALUES` statement, with a row limit

The three listing tools print the write policy in force on every call. Policies are optional and set from the **Vault policies** page in the Home Assistant sidebar — see [docs/policies.md](docs/policies.md). The search-then-edit workflow is in [docs/search-and-edit.md](docs/search-and-edit.md), SQLite in [docs/sqlite.md](docs/sqlite.md).

## Limitations

- **Read files one at a time.** `read_multiple_files` puts every file whole into a single response with no size cap; for large files use `read_text_file` with `offset`/`limit`, or `grep_files` to find the lines first.
- **SQLite is read-only and will stay so.** There is no write path and no flag that enables one.
- **There is no delete.** `trash_file` moves a file into a trash directory, and only in a zone that has a trash configured.
- **Clients cache the tool list.** After an update that changes tools, an already-open conversation keeps the old list — see Troubleshooting.
- **Policies stop this app's tools only.** Samba, the file editor or a `shell_command` write straight to the filesystem and never see a marker.
- `grep_files` skips binaries, symlinks, files over 20 MB and `.git` / `node_modules` / `.svn` / `.hg`; its answer is capped at 60 KB and says so when truncated.
- `directory_tree` goes two levels deep.

## Troubleshooting

- **The client shows old tools or old parameters after an update.** Refresh the connector's tool list and start a new chat. The tell for a stale schema is `write_file` without a `rev` parameter.
- **claude.ai shows no tools, but `curl` works.** Set `log_requests: true`, restart, and watch the log during registration. If no requests arrive, look upstream at the proxy or tunnel.
- **401 / 404 / 405 / 406.** 401 means a wrong token prefix, 404 a path other than `/mcp`, 405 a method other than `POST`, and 406 an `Accept` header without `application/json` or `text/event-stream`.
- **Every write is refused and the listing tools print `⚠ Policy: BROKEN MARKER`.** A `.vault-policy` file is unreadable and locks its zone. Fix it from the Vault policies page first.

Details are in [docs/troubleshooting.md](docs/troubleshooting.md).

## Security

- The path prefix is the password. Use a random UUID, never the default `changeme`, and put TLS in front of port 3100.
- Every path is confined to `vault_path`: a path outside it, a symlink pointing out of it, or a sibling directory sharing its name prefix is refused, and nothing is read or written.
- The auth proxy forwards only `/mcp`. Every other path answers 404 before it reaches the server.
- The Vault policies page is a separate process on internal port 3101, reachable only through Home Assistant ingress. It accepts connections from the Supervisor address `172.30.32.2` only and cannot be reached through the token URL.
- `grep_files` runs in a child process that is killed after 10 seconds, so a runaway regex cannot hang the server.
- SQLite runs as `sqlite3 -readonly -safe`: `ATTACH` and the other ways out of the vault through SQL are disabled.

## Links

- [docs/](docs/) — [tools](docs/tools.md), [configuration](docs/configuration.md), [write policies](docs/policies.md), [sqlite](docs/sqlite.md), [search and editing](docs/search-and-edit.md), [troubleshooting](docs/troubleshooting.md), [internals](docs/internals.md)
- [Changelog](filesystem_mcp/CHANGELOG.md)
- [License](LICENSE) — MIT
