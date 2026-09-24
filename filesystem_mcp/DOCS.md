# Filesystem MCP Server

An MCP server over Streamable HTTP that gives an assistant read and write access to one directory tree, the "vault": text and PDF reading, regex content search, line-addressed editing with an optimistic lock, and read-only SQLite. This page covers running the app. The full reference is on GitHub: [documentation index](https://github.com/st412m/ha-filesystem-mcp/tree/main/docs).

## Configuration

| Option | Default | What it does |
|---|---|---|
| `token` | `changeme` | Secret in the URL path. Change it before exposing the port. |
| `vault_path` | `/media/VAULT` | The one directory the server may touch, under `/media` or `/share`. |
| `log_requests` | `false` | Log every request (method, path with the token masked, status, bytes, user agent). |

Restart the app after changing an option.

The endpoint is `/private_<token>/mcp` on port 3100. For claude.ai, publish port 3100 through a reverse proxy that terminates TLS and use `https://<your-host>/private_<token>/mcp` as the connector URL. Only `/mcp` is served; a wrong token gets 401, any other path 404.

Ports `3099` (the MCP server) and `3101` (the Vault policies page) are internal.

More: [configuration](https://github.com/st412m/ha-filesystem-mcp/blob/main/docs/configuration.md).

## Fresh install

On the first start into a vault without `CLAUDE.md`, the app creates `raw/ha`, `raw/projects`, `wiki/ha/{devices,automations,network}`, `wiki/projects`, a starter `CLAUDE.md` and `log.md`. This happens once. A directory deleted afterwards stays deleted, and an existing vault is never re-seeded.

## Write policies

With no policies, any tool may write anywhere in the vault. To restrict a directory, open **Vault policies** in the Home Assistant sidebar and choose a mode for it. The rule applies to the directory and everything below it until a deeper marker overrides it.

| Mode | Effect |
|---|---|
| inherits | no marker here; the rule from above applies |
| read-only | no writes, edits, moves in or out, or discards; reading is unaffected |
| edits with rev | new files are free; changing, moving out or discarding an existing file requires its current `rev` |
| free writes | no checks |
| new files only | existing files may not be changed |

**Edits with rev** is the mode for a wiki. A refusal always states the current `rev`, so the retry succeeds.

Put policies on the top-level directories; the page shows only the root and what sits directly in it. Markers placed deeper by hand are listed with a button to remove them.

**Trash.** There is no delete. With the trash switched on for a zone, `trash_file` moves a file into `.vault-trash`, keeping its relative path and stamping the arrival time (UTC) into the name. Trash contents drop out of searches and listings but stay readable by explicit path. A zone with no trash cannot discard anything.

**Auto-purge** is off by default. When enabled, files older than the set number of days are erased from that zone's trash, one at a time, shortly after start and then daily. Files without an arrival stamp are never touched. If your backup is a mirror without history, a purge also removes the file from the backup at its next run.

**A broken marker locks its zone.** A `.vault-policy` that is not valid JSON, or carries a field the app does not know, stops all writes and deletion in its whole subtree, including subdirectories with valid markers. Reading keeps working, and the listing tools print `⚠ Policy: BROKEN MARKER`. A broken marker at the vault root locks the entire vault, so the assistant cannot even write its log. Fix the marker first: on the Vault policies page, or over Samba or with the file editor.

**Policies stop this app's tools only.** Samba, the file editor or a `shell_command` write straight to the filesystem and never see a marker.

More: [write policies](https://github.com/st412m/ha-filesystem-mcp/blob/main/docs/policies.md).

## Tools

- Reading: `read_text_file`, `read_file` (deprecated alias), `read_multiple_files`, `read_media_file`, `read_pdf_text`, `read_pdf_page`
- Searching: `grep_files`, `search_files`
- Writing: `write_file`, `edit_file`, `create_directory`, `move_file`, `trash_file`
- Listing: `list_directory`, `list_directory_with_sizes`, `directory_tree`, `get_file_info`, `list_allowed_directories`
- SQLite: `sqlite_schema`, `sqlite_query`

Read files one at a time: `read_multiple_files` returns every file whole in one response.

More: [tools](https://github.com/st412m/ha-filesystem-mcp/blob/main/docs/tools.md), [search and editing](https://github.com/st412m/ha-filesystem-mcp/blob/main/docs/search-and-edit.md).

## If the tool list looks wrong

After an update, a client may keep offering the tools and parameters it fetched earlier. Refresh the connector's tool list in the client, then start a new chat. The quick test is `write_file`: if it has no `rev` parameter, the client holds a schema from before 2.6.0. Do not go by the number of tools; it changes between releases.

More: [troubleshooting](https://github.com/st412m/ha-filesystem-mcp/blob/main/docs/troubleshooting.md).

## SQLite

`sqlite_schema` and `sqlite_query` run `sqlite3 -readonly -safe`: nothing is written, and `ATTACH` and the other ways out of the vault through SQL are disabled. A database with a non-empty `-wal` journal is read from a private copy that is removed after the call; without one it is opened in place. Either way no file is left next to the original.

`sqlite_query` accepts one statement starting with `SELECT`, `WITH`, `VALUES` or `EXPLAIN`. `EXPLAIN` and `EXPLAIN QUERY PLAN` must be followed by a `SELECT`, `WITH` or `VALUES` of their own; the modifier is lifted outside the wrapper, so the plan describes the wrapped statement and gains rows the bare query would not have (`CO-ROUTINE`, `SCAN (subquery-N)`), and `limit` is applied only after sqlite has produced the whole listing, so a very large plan hits `OUTPUT_TOO_LARGE` with no partial result. The statement is tokenized before `sqlite3` runs, so a `;` inside a string literal, a quoted identifier or a comment is accepted, and only a `;` that really ends a statement is refused with `MULTIPLE_STATEMENTS`. Bind parameters (`?`, `:x`, `@x`, `$x`, `#x`) are refused with `PARAMETERS_NOT_SUPPORTED` — there is nothing to bind them to, so write the value into the SQL as a literal. Unterminated literals and comments and unbalanced parentheses are refused with `MALFORMED_SQL` before `sqlite3` starts.

Every call runs under a 256 MiB working-memory limit. A query that needs more is stopped with `QUERY_TOO_LARGE`; if the `sqlite3` build does not confirm the limit, the query is refused with `HEAP_LIMIT_UNCONFIRMED`.

The first time you read a database, note a row count or a total and re-check it after updates: a wrong answer from a database looks like a normal result.

More: [sqlite](https://github.com/st412m/ha-filesystem-mcp/blob/main/docs/sqlite.md).

## Security

Anyone holding the token URL has full access to the vault, so treat it as a password and put TLS in front of the port if it leaves the LAN. The proxy passes only `/mcp` through. The Vault policies page runs as a separate process on an internal port, reachable only through Home Assistant ingress, never through the token URL.

## Links

- [Changelog](https://github.com/st412m/ha-filesystem-mcp/blob/main/filesystem_mcp/CHANGELOG.md)
- [Internals](https://github.com/st412m/ha-filesystem-mcp/blob/main/docs/internals.md)
- [License (MIT)](https://github.com/st412m/ha-filesystem-mcp/blob/main/LICENSE)
