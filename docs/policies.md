# Write policies

How to restrict writing in parts of the vault: the `.vault-policy` marker, its fields and modes, the trash, auto-purge, and what happens when a marker is broken. Read this before switching on any restriction, or when a write is refused and you want to know why.

## Default: none

With no markers anywhere, every tool may write anywhere in the vault. Nothing is switched on by installing or updating the app.

## The marker

A policy is a JSON file named `.vault-policy` in a directory. It applies to that directory and everything below it, until a deeper marker is met. Inheritance is per field: a deeper marker that sets only `readonly` keeps the parent's `trash`, `overwrite` and the rest.

| Field | Values | Default without any marker |
|---|---|---|
| `readonly` | `true` / `false` | `false` |
| `overwrite` | `"rev"`, `"never"`, `"free"` | `"free"` |
| `trash` | a single directory name, or `null` for no trash | `null` |
| `retention_enabled` | `true` / `false` | `false` |
| `retention_days` | whole number, 1–3650 | 30 |
| `_` | free text, ignored | |

Any other field is an error, and so is a wrong type or value (see [If a marker breaks](#if-a-marker-breaks)).

Markers are read on every tool call, with no cache between calls, so a change on the page applies to the next call.

## Modes

The **Vault policies** page offers five modes per directory. Each maps onto the fields:

| Page mode | Fields | Effect |
|---|---|---|
| inherits | no marker | the rule from above applies |
| read-only | `readonly: true`, `overwrite: "never"` | no writes, edits, moves in or out, or discards; reading is unaffected |
| edits with rev | `overwrite: "rev"` | new files are free; changing, moving out or discarding an existing file requires its current `rev` |
| free writes | `overwrite: "free"` | no checks |
| new files only | `overwrite: "never"` | new files are free; existing files cannot be changed, moved out or discarded |

**Edits with rev** is the mode for a wiki: nothing can overwrite a page the caller has not read. The `rev` is an 8-hex content hash. It comes back from `grep_files`, `read_text_file` with `offset`, `get_file_info`, `write_file` and `edit_file`. A missing or stale `rev` is refused, nothing is written, and the refusal states the current `rev` so the retry can succeed.

## The Vault policies page

The app adds **Vault policies** to the Home Assistant sidebar. The page is served through ingress only; it is not reachable through the token URL. It is the only thing that writes markers. MCP tools refuse to create, change, move or discard anything named `.vault-policy`, including a directory of that name.

The page shows the vault root and the directories directly inside it: put policies on top-level directories and let everything below inherit. A marker placed deeper by hand is listed separately, with a button to remove it. Choosing **inherits** removes a directory's marker.

For each directory with a mode other than read-only or inherits, the page offers a **trash** checkbox, and once the trash is on, **auto-purge** with a number of days.

## Trash

There is no delete. `trash_file` moves a file into the trash of its zone, `.vault-trash` by default. The path is kept relative to the directory that owns the trash, and the arrival time is stamped into the name in UTC:

```
wiki/system/foo.md  →  wiki/.vault-trash/system/foo__trash-20260905T050121Z.md
```

A second file with the same name and stamp gets `-1`, `-2` and so on after the stamp.

- A zone with no trash configured cannot discard anything.
- A read-only zone cannot discard anything.
- Directories are not discarded as a unit: trash the files inside one by one.
- `move_file` into a trash directory is refused; use `trash_file`.
- Trash contents are excluded from `grep_files`, `search_files`, `directory_tree` and `read_multiple_files`. They stay readable by explicit path with `read_text_file`.
- `list_directory` and `list_directory_with_sizes` flag a directory that looks like a trash but that no policy in force claims, and leave it alone.

## Auto-purge

Off by default, set per zone on the marker that defines the trash. When enabled, the app erases files older than `retention_days` from that zone's trash: once shortly after start, then once a day. Age is read from the stamp in the name, not from mtime.

- Files are removed one at a time, and emptied directories with `rmdir`. There is no recursive delete anywhere in the app.
- A file whose name has no stamp is never touched: it was put there by hand.
- Only the zone that owns the trash purges it; a child zone that inherits the trash does not.
- Each sweep writes a `[retention]` summary line to the app log.

Before enabling it, check how the vault is backed up. If the backup is a mirror with no history (for example `rsync --delete` without `--backup-dir`), a purged file disappears from the backup at its next run.

## Order of checks

A refusal names the first rule that applies. The policy checks run from hardest to softest:

1. The path is inside the vault.
2. The target is not named `.vault-policy`.
3. The zone's marker chain is readable.
4. The zone is not read-only.
5. For `trash_file`, the zone has a trash.
6. `overwrite: "never"` or `"rev"` for existing files.
7. Only then the content, such as whether `oldText` is present.

So a read-only zone refuses an edit without looking at the file.

## If a marker breaks

A `.vault-policy` that is not valid JSON, has an unknown field or a bad value, or is a directory or symlink instead of a file, **locks its zone**. No writes, no deletion; reading keeps working. The listing tools print `⚠ Policy: BROKEN MARKER — zone locked (read-only, no deletion).` followed by the file and the reason.

The lock covers the whole subtree, including directories with valid markers of their own, and a broken marker does not fall back on its parent's rule. A broken marker at the vault root therefore locks the entire vault, and the agent cannot even write its own log. Fix the marker first: from the Vault policies page, or over Samba or the file editor.

## What a policy does not cover

Policies stop this app's tools and nothing else. Samba, the file editor, a Home Assistant `shell_command` or a script on the host write straight to the filesystem and never see a marker. A read-only `raw/` constrains the agent while your own sync jobs keep working.
