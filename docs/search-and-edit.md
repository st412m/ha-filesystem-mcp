# Search and edit

How to find a line in a large file and change it without reading the whole file: `grep_files` → `read_text_file` with `offset`/`limit` → `edit_file` with line numbers, held together by `rev`. Read this before editing by line number, or when an edit is refused with a `rev` mismatch.

## The loop

**1. Find the line.**

```
grep_files  path=/media/VAULT/wiki  pattern="backup-rotation"  include=*.md
```

```
/media/VAULT/wiki/todo.md · rev 5db20d56 · 212 lines
  148: - [ ] Check backup-rotation settings on the NAS

— 1 match(es) in 1 file(s) · scanned 37/37 files, 190 KB, 12 ms
```

The header gives the path, the file's `rev` and its line count. Each matching line is `<number>: <text>`. With `context`, neighbouring lines are printed as `<number>- <text>`, and `--` separates non-adjacent groups.

**2. Read around it, if needed.**

```
read_text_file  path=/media/VAULT/wiki/todo.md  offset=144  limit=8
```

```
/media/VAULT/wiki/todo.md · rev 5db20d56 · lines 144-151 of 212
## Storage
- [x] Replace the USB hub
…
```

The first line is a header; the file's lines follow without numbers. Line `offset` is the first line after the header.

**3. Edit by line number.**

```
edit_file  path=/media/VAULT/wiki/todo.md  rev=5db20d56
           edits=[{startLine:148, endLine:148, newText:"- [x] Check backup-rotation settings on the NAS"}]
```

```
1 line edit(s) — /media/VAULT/wiki/todo.md
lines 212 → 212 · rev 5db20d56 → c31af9e1
```

The reply carries the new `rev`. Use it for the next edit to the same file.

## `rev`

`rev` is the first 8 hex characters of the SHA-256 of the file's content. Every step above reports it, and so do `get_file_info`, `write_file` and every `edit_file` reply.

A line edit without `rev` is refused. A line edit whose `rev` no longer matches the file is refused and nothing is written: the file changed since you read it, so the line numbers may point somewhere else. Re-read and redo the edit. `oldText` edits do not need `rev`, except in a zone with `overwrite: "rev"` (see [policies.md](policies.md)).

## Line edits

Each edit is `{startLine, endLine, newText}`, 1-based:

| Shape | Effect |
|---|---|
| `{startLine: 10, endLine: 12, newText: "x"}` | replace lines 10–12 with `x` |
| `{startLine: 10, endLine: 12, newText: ""}` | delete lines 10–12 |
| `{startLine: 10, newText: "x"}` | insert `x` before line 10 |
| `{startLine: lines+1, newText: "x"}` | append `x` at the end of the file |

- **Omitting `endLine` inserts; replacing needs an explicit `endLine`.** On a 12-line file `{startLine: 13, newText: "x"}` appends. On an empty file, append with `startLine: 1`.
- `newText` may span several lines separated by `\n`. It should not end with `\n` unless you want an extra blank line.
- `newText: ""` at an insert position is an error: there is nothing to delete.
- `startLine` beyond `lines`+1, and an `endLine` past the last line, are errors, each naming the valid form.
- Several edits in one call are applied bottom-up in one atomic pass, so line numbers from a single `grep_files` or `read_text_file` stay valid for all of them.
- Overlapping ranges, two inserts at the same position, and an insert inside a range replaced by the same call are refused.
- `{oldText}` and `{startLine}` edits cannot be mixed in one call.
- `dryRun: true` returns the planned changes and writes nothing.

## What is preserved

- CRLF line endings: inserted lines get `\r\n` in a CRLF file.
- A byte-order mark at the start of the file.
- A missing final newline stays missing.

Line numbers count the same way everywhere: `grep_files`, `read_text_file` (`head`, `tail`, `offset`), `get_file_info` and `edit_file` agree on how many lines a file has. A final newline does not add an empty last line.

## `grep_files` behaviour

- Long lines are clipped around the match, not from the start; `max_line_length` defaults to 200 characters.
- The answer is capped at `max_results` (default 50) and at about 60 KB. When either cap is hit, the reply ends with a `⚠ TRUNCATED` line and the list is incomplete.
- `include` and `exclude` are globs matched against the file name, with comma-separated alternatives: `include="*.md,*.yaml"`. Only `*` and `?` are special.
- Skipped: symlinks, binary files (a NUL byte in the first 4 KB), files over 20 MB, `.git`, `node_modules`, `.svn`, `.hg`, and trash directories. The footer counts skipped binary and over-size files.
- A regex that does not finish in 10 seconds is killed, typically one with nested quantifiers like `(a+)+`. Simplify the pattern or narrow `path` and `include`.
