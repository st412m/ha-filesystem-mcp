# Tools

Every tool the server offers, with its parameters and what it returns. Look here when you need an exact parameter name, a default, or the difference between two similar tools. The grouping matches the README.

All paths are absolute paths inside `vault_path`. A path outside the vault is refused with the code `PATH_OUTSIDE_VAULT`, and nothing is read or written. That covers a path that simply points elsewhere, one that climbs out with `..`, one that reaches a sibling directory whose name merely starts with the vault's own, and one that resolves out through a symlink — including the case where the symlink leads back inside, which is checked at the destination of every write. An error comes back as a normal tool result with `isError: true` and text starting with `Error: `.

## Reading

### `read_text_file`

| Parameter | Type | |
|---|---|---|
| `path` | string | required |
| `head` | number | first N lines |
| `tail` | number | last N lines |
| `offset` | number | first line of a range, 1-based |
| `limit` | number | number of lines from `offset` |

Without parameters it returns the file's bare contents. `head` and `tail` return N lines from an edge. `offset`/`limit` is the only form that changes the response shape: it prepends a header with the file's `rev` and line count, which `edit_file` needs for line edits:

```
/media/VAULT/wiki/notes.md · rev 3f9a1c07 · lines 40-54 of 212
```

`offset` past the end of the file is an error; `limit` past the end is clipped.

### `read_file`

Deprecated alias of `read_text_file`, same parameters.

### `read_multiple_files`

`paths` (array of strings). Returns each file whole, under a `=== <path> ===` header; a file that fails gets an `ERROR:` line instead of stopping the batch. Files inside a trash directory are skipped. There is no size cap, so read large files one at a time.

### `read_media_file`

`path`. Images (`.jpg`, `.jpeg`, `.png`, `.gif`, `.webp`, `.bmp`, `.svg`) and audio (`.mp3`, `.wav`, `.ogg`, `.flac`) come back base64-encoded with their MIME type. A PDF returns one page as JPEG, preceded by `Page N of M`; choose the page with a `#N` suffix on the path (`/media/VAULT/raw/manual.pdf#3`), default 1.

### `read_pdf_text`

| Parameter | Type | |
|---|---|---|
| `path` | string | required, must end in `.pdf` |
| `first_page` | number | default 1 |
| `last_page` | number | default: last page |

Runs `pdftotext -layout` and returns `Pages X-Y of N` followed by the text. A scanned PDF with no text layer returns a note suggesting `read_pdf_page`. Prefer this to page images: it is far smaller.

### `read_pdf_page`

`path`, `page` (both required). Renders one page as JPEG, 1400 px on the long side, preceded by `Page N of M`. Use it when layout or graphics matter, or for scans.

## Searching

### `grep_files`

| Parameter | Type | Default | |
|---|---|---|---|
| `path` | string | | required; file or directory, searched recursively |
| `pattern` | string | | required; JavaScript regex |
| `ignore_case` | boolean | `false` | |
| `include` | string | | filename glob, comma-separated: `"*.md,*.yaml"` |
| `exclude` | string | | glob of file or directory names to skip |
| `context` | number | 0 | lines around each match, 0–20 |
| `max_results` | number | 50 | 1–1000 |
| `max_line_length` | number | 200 | 40–4000; long lines are clipped around the match |

Returns, per file, a header line with path, `rev` and line count, then the matching lines. The footer counts matches, files and scanned bytes. The output format and the full workflow are in [search-and-edit.md](search-and-edit.md).

Skipped: symlinks, binary files (a NUL byte in the first 4 KB), files over 20 MB, `.git`, `node_modules`, `.svn`, `.hg`, and trash directories. The answer stops at `max_results` or at about 60 KB, whichever comes first, and then ends with a `⚠ TRUNCATED` line. The search runs in a child process that is killed after 10 seconds.

### `search_files`

`path`, `pattern` (required), `excludePatterns` (array of strings). Finds files and directories whose name or full path contains `pattern` as a plain substring, recursively. Entries whose name contains any of `excludePatterns` are skipped, and so are trash directories. For file contents use `grep_files`.

## Writing

### `write_file`

`path`, `content` (required), `rev`. Creates or overwrites a file, creating parent directories as needed. Returns `Written:` or `Overwritten:` with the new `rev`. In a zone with `overwrite: "rev"`, overwriting an existing file requires its current `rev`; creating a new file does not. In an `overwrite: "never"` zone an existing file cannot be overwritten.

### `edit_file`

| Parameter | Type | |
|---|---|---|
| `path` | string | required |
| `edits` | array | required; objects with `newText` and either `oldText` or `startLine`/`endLine` |
| `rev` | string | required for line edits |
| `dryRun` | boolean | show what would change, write nothing |

Two edit shapes, not mixed in one call:

- `{oldText, newText}` replaces the first literal occurrence of `oldText`. Fails if `oldText` is not found.
- `{startLine, endLine, newText}` replaces lines `startLine`–`endLine` inclusive. Omitting `endLine` inserts before `startLine`; `startLine` = line count + 1 appends. Requires `rev`.

The reply carries the new `rev`. The semantics of line edits are in [search-and-edit.md](search-and-edit.md). In a zone with `overwrite: "rev"` every edit needs `rev`, including `oldText` edits; in an `overwrite: "never"` zone editing is refused.

### `create_directory`

`path`. Creates the directory and any missing parents.

### `move_file`

`source`, `destination` (required), `rev`. Moves or renames a file or directory. Taking a file out of a zone with `overwrite: "rev"` requires its current `rev`; a directory cannot be taken out of a zone whose `overwrite` is not `free`. Moving into a trash directory by hand is refused: use `trash_file`.

### `trash_file`

`path` (required), `rev`. Moves a file into the trash of its zone, keeping its path relative to the directory that owns the trash and adding an arrival timestamp to the name. Fails if the zone has no trash configured, or if the path is a directory. In a zone with `overwrite: "rev"` the current `rev` is required. See [policies.md](policies.md#trash).

## Listing

`list_directory`, `list_directory_with_sizes` and `directory_tree` start their output with the policy in force for that directory and where it comes from, for example:

```
Policy: none — unrestricted (no .vault-policy marker above this directory).
```

### `list_directory`

`path`. One line per entry, prefixed `[DIR]` or `[FILE]`.

### `list_directory_with_sizes`

`path` (required), `sortBy` (`name` or `size`, default `name`). Like `list_directory`, with file sizes in KB and a total.

### `directory_tree`

`path`. Indented tree, two levels below `path`. Trash directories are omitted and counted in a footer.

### `get_file_info`

`path`. JSON with `path`, `size`, `isFile`, `isDirectory`, `created`, `modified`, and for text files up to 20 MB also `lines` and `rev`.

### `list_allowed_directories`

No parameters. Returns the vault root.

## SQLite

### `sqlite_schema`

| Parameter | Type | Default | |
|---|---|---|---|
| `path` | string | | required |
| `counts` | boolean | `false` | add `COUNT(*)` per table |
| `counts_timeout_ms` | number | 60000 | per-table budget, max 600000 |

### `sqlite_query`

| Parameter | Type | Default | |
|---|---|---|---|
| `path` | string | | required |
| `sql` | string | | required; one statement |
| `limit` | number | 100 | max 1000 |
| `timeout_ms` | number | 5000 | max 30000 |

Response fields, refusal codes and the handling of WAL databases are in [sqlite.md](sqlite.md).

## Close pairs

| | |
|---|---|
| `grep_files` / `search_files` | contents by regex / names by substring |
| `read_text_file` / `read_multiple_files` | one file, optionally a range with `rev` / several whole files, no `rev` |
| `read_pdf_text` / `read_pdf_page` / `read_media_file` | text / one page as JPEG / one page as JPEG chosen by `#N`, plus images and audio |
| `write_file` / `edit_file` | whole content / part of a file |
| `move_file` / `trash_file` | relocate / discard into the zone's trash |
| `list_directory` / `directory_tree` | one level / two levels |
