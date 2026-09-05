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

MCP tools refuse to create, change, move or discard anything named
`.vault-policy`, `create_directory` included. A *directory* with that name would
make the marker unreadable and lock the zone permanently from the tool side.

## Tools

Reading: `read_text_file` (whole file, `head`/`tail`, or an `offset`/`limit`
range that also reports line count and `rev`), `read_multiple_files`,
`read_media_file`, `read_pdf_text`, `read_pdf_page`, `grep_files`.

Writing: `write_file`, `edit_file` (literal `oldText` replacement or
line-addressed edits under an optimistic lock), `create_directory`, `move_file`,
`trash_file`.

Listing: `list_directory`, `list_directory_with_sizes`, `directory_tree`,
`search_files`, `get_file_info`, `list_allowed_directories`.

The three listing tools print the policy in force and where it comes from, every
time. Silence would be read as "no restrictions", and the truth would arrive as
a refusal — that is, after a mistake.

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
