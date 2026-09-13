# Filesystem MCP Server

An MCP server over Streamable HTTP that gives an assistant read and write access
to one directory tree — a "vault" — plus PDF text and page extraction, a regex
content search, and line-addressed editing with an optimistic lock.

## Configuration

| Option | Default | What it does |
|---|---|---|
| `token` | `changeme` | Secret in the URL path. The endpoint is `http://<host>:3100/private_<token>/mcp`. Change it. |
| `vault_path` | `/media/VAULT` | The one directory the server may touch. Nothing outside it is reachable, symlinks pointing out are refused. |
| `log_requests` | `false` | Log every proxied request (method, path with the token masked, status, bytes, user agent). |

Port `3100` is the only published port. `3099` (the MCP server) and `3101` (the
policy page) are internal.

## Write policies

By default there are none, and the add-on behaves as it always has: any tool may
write anywhere in the vault. Strictness is opt-in, per directory, and is
configured from the **Vault policies** page in the Home Assistant sidebar.

A policy is a small JSON file named `.vault-policy` that the page writes into a
directory. It applies to that directory **and everything below it**, until a
deeper `.vault-policy` overrides it. Fields the deeper marker does not mention
keep the value inherited from above.

### Modes

- **inherits** — no marker here; the rule from above applies.
- **read-only** — tools may not write, edit, move anything in or out, or
  discard. Reading is unaffected.
- **edits with rev** — creating a new file is free; changing or moving out an
  **existing** file requires its current `rev`. The `rev` is a short hash of the
  content, and it comes back from `grep_files`, from `read_text_file` with
  `offset`, from `get_file_info`, and in the reply to the previous edit. If it
  is missing or stale the call is refused and the refusal states the current
  `rev`, so the retry succeeds. This is the mode to use for a wiki: it makes
  clobbering a page you have not read impossible.
- **free writes** — 2.5.x behaviour, no checks.
- **new files only** — existing files may not be changed at all.

### Trash

There is no delete. `trash_file` moves a file into the trash of its zone,
`.vault-trash` by default, keeping its path relative to the directory that owns
the trash — `wiki/system/foo.md` lands at `wiki/.vault-trash/system/foo.md` —
and stamping the arrival time into the name (`foo__trash-20260905T050121Z.md`).
The stamp is in UTC. It is there because a move does not change mtime, so
without it a page that had lived in the wiki for six months would look ancient
the moment it was discarded.

Trash contents are excluded from `grep_files`, `search_files`, `directory_tree`
and `read_multiple_files` — a thrown-away version that keeps surfacing in
searches gets quoted again as if it were current. It is still readable by its
explicit path with `read_text_file`.

A zone with no trash configured cannot discard anything at all.

### Auto-purge

Off by default. When enabled for a zone, files older than the configured number
of days are erased from that zone's trash, once at start and once a day
thereafter. It removes files one at a time and empty directories with `rmdir` —
there is no recursive delete in this add-on — and it never touches a file whose
name carries no arrival stamp, on the assumption that you put it there by hand.

Before switching it on, know how your vault is backed up. If the backup is a
mirror (`rsync --delete` with no `--backup-dir`), a purge here disappears from
the backup at its next run, and there is no history to recover from.

### Where to put policies

Put them on the top-level directories and let everything below inherit. The page
only shows the root and what sits directly in it — that is deliberate, so it
draws instantly on a vault of any size. If some nested directory needs a
different rule, it is usually cleaner to lift that directory up to the top
level. A marker somebody placed deeper by hand is still listed on the page,
with a button to remove it.

### Order of checks

A refusal is decided from the hardest constraint to the softest, and the message
you get names the first one that applies. A zone with no trash refuses
`trash_file` on the grounds of the missing trash rather than asking for a `rev`
it would never use. A read-only zone refuses an edit before looking at whether
the text you asked to replace is even in the file.

The second one matters beyond tidiness. If content were inspected first, the
error messages would let a caller probe what is inside a zone it is not allowed
to write to.

### What a policy does not cover

**Read-only stops this add-on's tools and nothing else.** Anything else that
writes into the vault goes straight to the filesystem and never sees a marker: a
Home Assistant `shell_command` copying files in, Samba, the file editor add-on,
a script on the host. So `readonly` on `raw/` constrains the assistant while
leaving your own sync jobs working — which is usually what you want, but it is
worth knowing it is not a lock.

### If a marker breaks

A `.vault-policy` that is not valid JSON, or that carries a field the add-on
does not know, **locks its zone**: no writes, no deletion. Reading keeps
working. This is on purpose — quietly carrying on under a rule nobody can read
is worse than a stop you can see. The error names the file. Fix it from the
Vault policies page, or repair the file over Samba or with the file editor.

The lock reaches the whole subtree, **including directories that have perfectly
valid markers of their own**. A broken marker at the root of the vault therefore
locks the entire vault, not just the root: `wiki/`, `tmp/` and everything else
stop accepting writes even though their own markers parse fine. Nor does a
broken marker fall back on its parent's rule — it locks instead. Both directions
are deliberate, and they point the same way: when the chain of rules cannot be
read end to end, nothing is written.

Plan for one consequence of this. While the root marker is broken the assistant
cannot write anywhere at all, including whatever log or journal it keeps inside
the vault, so a session cannot even record that it was blocked. Repairing the
marker is the first thing to do, not something to come back to.

MCP tools refuse to create, change, move or discard anything named
`.vault-policy`, `create_directory` included. A *directory* with that name would
make the marker unreadable and lock the zone permanently from the tool side.

## Tools

Reading: `read_text_file` (whole file, `head`/`tail`, or an `offset`/`limit`
range that also reports line count and `rev`), `read_multiple_files`,
`read_media_file`, `read_pdf_text`, `read_pdf_page`, `grep_files`,
`sqlite_schema`, `sqlite_query`.

Writing: `write_file`, `edit_file` (literal `oldText` replacement or
line-addressed edits under an optimistic lock), `create_directory`, `move_file`,
`trash_file`.

Listing: `list_directory`, `list_directory_with_sizes`, `directory_tree`,
`search_files`, `get_file_info`, `list_allowed_directories`.

The three listing tools print the policy in force and where it comes from, every
time. Silence would be read as "no restrictions", and the truth would arrive as
a refusal — that is, after a mistake.

### If the tool list looks wrong

MCP clients cache `tools/list`. If yours offers 17 tools instead of 18, or shows
`write_file` with no `rev` parameter, it is holding schemas from before 2.6.0
and the policies will look broken from the client side while working perfectly
on the server. Starting a fresh conversation is not necessarily enough — the
cache can sit further out than that, and the connector has to be re-registered.

The cheap tell is the `rev` parameter on `write_file`, not the number of tools:
`rev` arrived with 2.6.0 and nothing else adds it, whereas the tool count has
moved for unrelated reasons across versions and is easy to misremember.

Starting a **new conversation** is not always enough by itself, either: some
clients cache `tools/list` per client *session*, not per conversation, and a
new conversation opened after the add-on restarted may reuse that session
without ever re-fetching the list — new tools then stay invisible, which
reads like "the feature never shipped" rather than a stale cache. A full
client-session reset (not just a new chat) clears it. With `log_requests:
true`, the `tools/list` response is a recognizable fingerprint in the log —
it weighs around 7 KB and nothing else on this server does; if calls are
coming in but that response never appears after a restart, the client is
still working from an old list.

## SQLite tools

`sqlite_schema` and `sqlite_query` open the file with `sqlite3 -readonly -safe`:
writes are impossible, and `-safe` disables `ATTACH`, `.shell`, `.open`,
`load_extension()` and the rest of the escape hatches, so a query cannot reach
outside the vault's own zone check through SQL.

### Opening a database with a WAL journal

A plain `-readonly` open of a WAL-mode database still creates a `-shm` file
(and a `-wal`, if none exists yet) next to it — harmless on its own, but the
common case for this add-on is a vault synced by Syncthing or similar, where
every read then propagates two new files to every other device. Since 2.7.2:

- No `-wal` next to the database, or an empty one (a leftover from before this
  fix, or from some other reader — not a real journal either way) — the file
  is opened in place via `sqlite3`'s `immutable=1` URI mode. No sibling files
  appear, and none are removed either, because none are created.
- A real, non-empty `-wal` — the database and its `-wal` are copied together
  into a private temporary directory for the duration of the call and read
  from there; the copy (and anything sqlite3 creates alongside it) is removed
  when the call finishes, success or failure. `immutable=1` is deliberately
  **not** used here: it tells sqlite3 the file will not change and nothing
  needs replaying, so on a database whose schema or rows live entirely in an
  uncheckpointed `-wal` it comes back with an empty schema or "no such table"
  — silently wrong, not an error.

Every response carries `wal_copy` (whether this call read from such a copy)
and `wal_copy_ms` (how long making it took, `null` when no copy was made) —
useful when one call is instant and the next on the same kind of database
takes noticeably longer for no obvious reason.

`sqlite_schema`'s `counts_timeout_ms` is a **per-table** budget, not a pool
shared across tables — each table gets its own full window, so one slow table
never eats into another's. But the window covers the *whole* per-table call:
spawning `sqlite3`, opening the database file, and running `COUNT(*)` — not
just the count itself. On a large database file, opening it can alone take
longer than an aggressive budget, so a very small `counts_timeout_ms` can time
out even a table with a handful of rows; that is the fixed per-invocation cost
dominating, not the row count, and it is not a sign the per-table budgeting is
broken. A table that times out is `null` in `counts`; every such table is
listed once in `counts_incomplete.tables`, with a single shared explanation in
`counts_incomplete.note` rather than the same sentence repeated per table.

`sqlite_query`'s `timeout_ms` bounds the one statement of that call — there is
nothing to share it across, since only one statement per call is accepted.

Every `sqlite3` call runs under a fixed working-memory limit of 256 MiB. A
query that tries to allocate more than that is stopped and reported as
`QUERY_TOO_LARGE`, which is a different failure from running out of time
(`QUERY_TIMEOUT`) or returning too much (`OUTPUT_TOO_LARGE`). The queries this
catches are the ones that allocate heavily in one place: a large sort,
`group_concat()` over many rows, `hex()` on a large BLOB.

The limit is verified rather than assumed. SQLite's memory limiter is only
active in builds that track allocations, and a build where it is compiled out
accepts the setting and silently ignores it. So the add-on reads back the
value SQLite reports, checks it as it arrives, and refuses to run the query at
all if it doesn't match — `HEAP_LIMIT_UNCONFIRMED`.

## Vault structure on a fresh install

On a **first** run into an empty vault the add-on creates `raw/ha`,
`raw/projects`, `wiki/ha/{devices,automations,network}`, `wiki/projects`, plus a
starter `CLAUDE.md` and `log.md`. It does this **once** and remembers it. Delete
a directory afterwards and it stays deleted. Upgrading an existing installation
never re-creates anything.

## Security

Everything on port 3100 is reachable by anyone holding the token, so treat it as
a password and put TLS in front of it if it leaves the LAN. The proxy passes
only `/mcp` through; every other path answers 404. The policy page is on a
separate internal port, served by a separate process, and is reachable only
through Home Assistant ingress, which authenticates the user itself — it is not
reachable through the token URL at all.
