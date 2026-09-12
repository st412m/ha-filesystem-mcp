# Changelog

## 2.7.0

**Read-only SQLite.** A `.db` file in the vault can now be inspected and
queried. Two tools: `sqlite_schema` returns the DDL of everything in the file
plus the pragmas that describe it, and `sqlite_query` runs a single `SELECT`
and returns rows. Nothing writes. There is no hidden flag that makes them
write, and no second stage planned — a database reached over a sync folder is
not a safe thing to modify, and a tool that can corrupt a backup is worse than
no tool.

### Added

- `sqlite_schema` — objects with their original DDL, `journal_mode`,
  `page_size`, `page_count`, `encoding`, `user_version`, `application_id`, the
  file's size and mtime in UTC and MSK, and whether `-wal` and `-shm` sit
  alongside. Row counts are **off by default**: `COUNT(*)` is a full scan.
  With `counts: true` each table gets its own `counts_timeout_ms` budget
  (default 60000). A table that runs out returns `null` and is named in
  `counts_incomplete`; the rest of the schema still comes back. The budget
  covers spawning `sqlite3` and opening the database, not just the count
  itself, so a very small budget fails every table regardless of its size.
  Row count predicts count time poorly — which indexes exist matters more.
- `sqlite_query` — one statement, wrapped so that overflow is detectable:
  ask for `limit` rows and you are told plainly when there were more.
  `timeout_ms` kills a runaway query. Output is capped; a result too large to
  return is an error, never a silent partial answer.

### How it refuses

Both tools go through the `sqlite3` binary in read-only safe mode. Safe mode
matters for more than writes: it blocks `ATTACH`, which would otherwise let a
query read any file on the host and walk straight around the zone policy. Dot
commands, `writefile()`, `edit()` and extension loading are refused with it.

Statements are checked before they run and each refusal says which rule was
hit: a dot command, more than one statement, or something that isn't a
`SELECT`, `WITH`, `VALUES` or `EXPLAIN`. The multi-statement check is a plain
search for `;`, so a query carrying a semicolon inside a string literal is
refused too. That is a real limitation and it fails loudly rather than being
parsed heuristically.

A file is identified by its first sixteen bytes, not by its extension. A
SQLite database named `.fydb` works; a text file named `.db` is rejected with
its header quoted back.

### Notes

- BLOB columns are returned as-is and will be unreadable in JSON. Wrap them:
  `hex(col)` or `length(col)`.
- An uncheckpointed database with a `-wal` beside it reads fine as long as the
  containing directory is writable, because SQLite creates the `-shm` index
  itself; reading one leaves that `-shm` behind. Where the directory denies
  writes — a read-only mount, a share without write permission — the open
  fails and `WAL_PRESENT_READONLY` explains why instead of passing SQLite's
  "attempt to write a readonly database" through unhelpfully.
- No new npm dependencies. The image gains the `sqlite` package; the toolchain
  check guards its major version at build time and verifies that safe mode
  really does refuse `ATTACH`.

Everything else is unchanged from 2.6.0.

## 2.6.0

**Write policies.** A directory can now be marked read-only, or made to require
a file's current `rev` before anything overwrites it, and can be given a trash
instead of a delete. The rule applies to that directory and everything below it
until a deeper marker overrides it. **Nothing is switched on by an update**: a
vault with no markers behaves exactly as it did in 2.5.2. Turn strictness on
where you want it from the new **Vault policies** page — the add-on now appears
in the Home Assistant sidebar (admins only). Full documentation is on the
add-on's Documentation tab.

### Removed

- **`POST /write` is gone.** It wrote any file in the vault with no version
  check and no token of its own, and the auth proxy forwarded it straight from
  the internet, so any policy below it could be bypassed with one `curl`. If you
  used it from a `rest_command`, remove that command — there is no replacement;
  write through the MCP tools.
- The auth proxy no longer blind-forwards. Only `/mcp` is passed through;
  everything else answers 404 before reaching the server.

### Added

- `.vault-policy` markers: `readonly`, `overwrite` (`rev` / `never` / `free`),
  `trash`, `retention_enabled`, `retention_days`.
- **Vault policies** page over ingress: one level of the tree, a mode per
  directory, trash and auto-purge toggles. The only thing that writes markers.
  MCP tools refuse to create, change, move or discard a `.vault-policy` — a
  directory of that name would lock a zone with no way to repair it from the
  tool side.
- `trash_file` — the only way to remove something. The file moves into its
  zone's trash keeping its relative path, with the arrival time stamped into
  the name. Trash contents are excluded from `grep_files`, `search_files`,
  `directory_tree` and `read_multiple_files`, so discarded pages stop turning up
  in searches; they are still readable by explicit path.
- Optional auto-purge of the trash, **off by default**, per zone. It removes
  files one by one — no recursive delete anywhere — and never touches a file
  whose name has no arrival stamp, i.e. anything you dropped in over Samba.
- `write_file` and `move_file` accept `rev`. In an `overwrite: "rev"` zone,
  overwriting an existing file or moving one out of the zone requires it;
  creating a new file does not. Every refusal quotes the current `rev`, so the
  second attempt succeeds.
- `list_directory`, `list_directory_with_sizes` and `directory_tree` now print
  the rule in force and where it comes from, on every call.

### Changed

- **A deleted directory is no longer recreated on restart.** Until now six
  `mkdir -p` ran on every start, so removing `raw/projects` lasted until the
  next restart. The skeleton is created once, on a fresh install, and remembered
  with a flag in `/data`. Existing installations are detected by the presence of
  `CLAUDE.md` and are never re-seeded.
- A corrupt marker, or one with an unknown field, locks its zone: no writes, no
  deletion, reading unaffected. This is deliberate — running quietly under a
  rule nobody can read is worse than stopping. The error names the file and how
  to fix it.

Reading is unchanged. `read_text_file` without a range still returns the bare
file contents, byte for byte as in 2.5.2.
