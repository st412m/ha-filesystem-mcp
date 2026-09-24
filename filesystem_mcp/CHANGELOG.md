# Changelog

## 2.8.0 — 2026-09-24

The check that a path is inside the vault now lives in one module and is verified by the modules behind it rather than assumed, zone refusals carry a code, `EXPLAIN` runs, and the SQL statement check is a tokenizer instead of a search for `;`.

### Added
- `safepath.js`: the one place a path is checked against the vault, handing back a verified path rather than a string.
- `EXPLAIN` and `EXPLAIN QUERY PLAN` run in `sqlite_query`, with the modifier lifted outside the wrapper.
- Refusal codes `MALFORMED_SQL` and `PARAMETERS_NOT_SUPPORTED`.

### Changed
- `policy.js`, `retention.js` and `sqlite.js` accept only a verified path and refuse a bare string before touching the disk.
- Zone refusals now start with the `PATH_OUTSIDE_VAULT` code, a visible change in every file tool.
- `trash_file` no longer carries a file out of the vault when the trash directory is a symlink pointing outside it: the destination is checked before the move.
- A write through a directory symlink that leaves the vault and leads back into it is now refused; the zone is taken from the verified parent.
- `create_directory` on the vault root itself is now refused.
- The Vault policies page no longer counts the files in a trash directory that is a symlink.
- `;` inside string literals, quoted identifiers and comments is accepted; bind parameters (`?`, `:x`, `@x`, `$x`, `#x`) are now rejected (previously they silently became NULL); unterminated literals and comments and unbalanced parentheses are rejected before `sqlite3` starts.
- The 406 message describes the actual rule: either media type is enough, not both.
- `test/make-fixtures.sh` resolves fixture paths against `VAULT_PATH`.
- The build-time smoke test checks that `EXPLAIN` comes back as JSON.

## 2.7.3 — 2026-09-22

Documentation split into a README and a `docs/` directory; build-time messages are now in English. Server behaviour is unchanged.

### Added
- `LICENSE` (MIT) at the repository root.

### Changed
- `README.md` is now a short landing page: requirements, installation, configuration, connecting, tools, limitations, troubleshooting, security.
- Detailed reference moved to `docs/`: tools, configuration, write policies, SQLite, search and editing, troubleshooting, internals.
- `DOCS.md` (the add-on's Documentation tab) is now an operator guide with absolute links into `docs/`.
- Version history moved from the README into this file, with release dates taken from the git tags.
- Toolchain guard and smoke-test messages in `toolchain-check.sh` are now in English.

## 2.7.2 — 2026-09-13

WAL-mode databases are read without leaving side files next to the original.

### Added
- `wal_copy` and `wal_copy_ms` in `sqlite_schema` and `sqlite_query` responses: whether the call read from a private copy and how long the copy took.

### Changed
- A database with no `-wal`, or an empty one, is opened in place through `immutable=1`, so no `-shm` or `-wal` appears beside it.
- A database with a non-empty `-wal` is read from a private copy made once per tool call and removed afterwards.
- `WAL_PRESENT_READONLY` now means preparing that copy failed (no space, unreadable source, unwritable temp directory), not a read-only mount.
- `test/make-fixtures.sh` runs under plain `sh`, requires `VAULT_PATH`, and writes to `$VAULT_PATH/tmp/fixtures` by default.

### Breaking
- `mtime_msk` removed; `mtime_local` replaces it, giving the container's local time with a numeric offset such as `+03:00`.

## 2.7.1 — 2026-09-12

A fixed 256 MiB working-memory limit on every `sqlite3` call.

### Added
- `QUERY_TOO_LARGE`: a query that exceeds the memory limit is stopped and reported as such.
- `HEAP_LIMIT_UNCONFIRMED`: the query is refused when the `sqlite3` build does not confirm the limit; the same check runs at image build time.
- `elapsed_ms` in `sqlite_schema` responses.

### Changed
- `NOT_SQLITE` shows the first sixteen bytes as ASCII next to the hex when they are printable.
- The `counts_incomplete` note is shorter.
- The `sqlite_schema` description advises calling without `counts` first.
- Text files are pinned to LF by `.gitattributes`.
- The PDF smoke test no longer prints poppler's missing-font warning.

## 2.7.0 — 2026-09-12

Read-only SQLite.

### Added
- `sqlite_schema`: DDL of every table, index, view and trigger, file pragmas, `sqlite3` version, presence of `-wal`/`-shm`, and optional per-table `COUNT(*)` with its own timeout budget.
- `sqlite_query`: one `SELECT`/`WITH`/`VALUES`/`EXPLAIN` statement with a row limit, truncation flag and timeout.
- Queries run under `sqlite3 -readonly -safe`, which disables `ATTACH`, dot commands, `writefile()`, `edit()` and extension loading.
- The image gains the `sqlite` package; the toolchain check guards its major version and verifies that `-safe` refuses `ATTACH`.

## 2.6.0 — 2026-09-05

Write policies, a trash instead of deletion, and an allow-list in the auth proxy.

### Added
- `.vault-policy` markers with the fields `readonly`, `overwrite` (`rev` / `never` / `free`), `trash`, `retention_enabled`, `retention_days`.
- **Vault policies** ingress page in the Home Assistant sidebar, the only thing that writes markers.
- `trash_file`: moves a file into its zone's trash with an arrival timestamp in the name.
- Optional per-zone auto-purge of the trash, off by default.
- `rev` parameter on `write_file` and `move_file`.
- `list_directory`, `list_directory_with_sizes` and `directory_tree` print the policy in force on every call.

### Changed
- Trash contents are excluded from `grep_files`, `search_files`, `directory_tree` and `read_multiple_files`.
- MCP tools refuse to create, change, move or discard anything named `.vault-policy`.
- A corrupt marker, or one with an unknown field, locks its zone against writes and deletion.
- The vault skeleton is created once, on a fresh install, instead of on every start.

### Breaking
- `POST /write` removed, with no replacement; the auth proxy now forwards only `/mcp`.

## 2.5.2 — 2026-08-18

Line edits without `endLine` insert instead of replacing.

### Added
- Refusals for `startLine` beyond `lines`+1, two inserts at one position, and an insert inside a range replaced by the same call.

### Breaking
- `{startLine: N, newText}` without `endLine` inserts before line N; replacing requires an explicit `endLine`.

## 2.5.1 — 2026-08-17

Two line-handling fixes.

### Changed
- `{startLine: lines+1}` without `endLine` appends at the end of the file.

### Fixed
- `tail=N` returned N−1 lines on files ending with a newline.

## 2.5.0 — 2026-08-16

Content search and line-addressed editing.

### Added
- `grep_files`: recursive regex search with `include`/`exclude` globs, `context`, `max_results` and `max_line_length`, run in a child process with a 10 s kill.
- `offset`/`limit` on `read_text_file`.
- `{startLine, endLine, newText}` edits in `edit_file`, guarded by `rev`.
- `lines` and `rev` in `get_file_info` for text files.

### Changed
- Existing tool descriptions shortened.

### Fixed
- Symlinks pointing out of the vault are refused.
- A sibling directory sharing the vault's name prefix no longer passes the path check.

## 2.4.1 — 2026-07-21

Supported architectures reduced to amd64 and aarch64.

### Breaking
- `armv7` dropped; supported architectures are amd64 and aarch64.

## 2.4.0 — 2026-07-21

Base image and toolchain moved to Alpine 3.22.

### Added
- Build-time toolchain guard and PDF smoke test (`toolchain-check.sh`).
- Toolchain versions and build manifest printed to the add-on log on start.

### Changed
- Base image set in the Dockerfile as `ghcr.io/home-assistant/base:3.22`; `build.yaml` removed.
- nodejs 20 → 22, poppler 24 → 25.
- Add-on version flows from `config.yaml` through `BUILD_VERSION` to `ADDON_VERSION`.
- `npm` removed from the image.

## 2.3.2 — 2026-07-13

Optional request logging for debugging connector issues.

### Added
- `log_requests` option: one log line per request in the auth proxy, token masked ([#4](https://github.com/st412m/ha-filesystem-mcp/issues/4)).

## 2.3.1 — 2026-07-12

Transport aligned with the MCP Streamable HTTP spec.

### Changed
- `POST /mcp` responds with `application/json` instead of a single-event SSE stream ([#4](https://github.com/st412m/ha-filesystem-mcp/issues/4)).

### Fixed
- `GET /mcp` returns `405 Method Not Allowed` instead of holding an idle SSE stream open ([#4](https://github.com/st412m/ha-filesystem-mcp/issues/4)).

## 2.3.0 — 2026-07-10

PDF text extraction and smaller tool responses.

### Added
- `read_pdf_text`: pdftotext with layout preservation and an optional page range.

### Changed
- `structuredContent` removed from tool responses ([#3](https://github.com/st412m/ha-filesystem-mcp/issues/3)).
- Unused SVG rendering path removed.

### Fixed
- `read_media_file` returns the total PDF page count.

## 2.2.2 — 2026-07-08

Array parameters sent as JSON strings are accepted.

### Fixed
- `TypeError` when a client sends array parameters as JSON strings, in `edit_file`, `read_multiple_files` and `search_files` ([#2](https://github.com/st412m/ha-filesystem-mcp/issues/2)).

## 2.2.1 — 2026-06-12

Multi-arch builds and `/share` support.

### Added
- Multi-arch builds (amd64, aarch64, armv7) via `build.yaml`.
- `share:rw` mapping, so `vault_path` can live under `/share`.

### Fixed
- Build failure on Supervisor 2026.04 and newer ([#1](https://github.com/st412m/ha-filesystem-mcp/issues/1)).

## 2.1.0 — 2026-04-25

HTTP write endpoint for automations.

### Added
- `POST /write` endpoint for Home Assistant automations (removed in 2.6.0).

## 2.0.0 — 2026-04-25

Custom HTTP MCP server replaces supergateway.

### Added
- Streamable HTTP transport.
- PDF page reading.

Releases before 2.0.0 predate this changelog and are not documented.
