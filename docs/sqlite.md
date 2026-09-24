# SQLite

Reading SQLite databases in the vault with `sqlite_schema` and `sqlite_query`: what they return, how they open the file, what they refuse and why a call might fail. Read this before pointing the tools at a database, or when one returns an error code.

Both tools are read-only. There is no write path and no option that adds one.

## How a database is opened

Every call runs the `sqlite3` binary with `-readonly -safe -json`, under a fixed working-memory limit of 256 MiB (`PRAGMA hard_heap_limit=268435456`). `-safe` disables `ATTACH`, `.shell`, `.open`, `writefile()`, `edit()` and `load_extension()`, so a query cannot read files outside the vault through SQL.

The file type is taken from the first sixteen bytes, not the extension: a database named `.fydb` is read, a text file named `.db` is refused with `NOT_SQLITE`.

Where the database is read from depends on its journal:

- **No `-wal` next to it, or an empty one** — opened in place through a `file:…?immutable=1` URI. No `-shm` or `-wal` is created beside the original.
- **A non-empty `-wal`** — the database and its `-wal` are copied together into a private temporary directory, read from there, and the copy is removed when the call ends, success or failure. The copy is made once per tool call, even when `counts: true` runs one count per table.

Either way nothing is left next to the original file. `wal_copy` and `wal_copy_ms` in every response say which path was taken and how long the copy took, which explains a call that is slower than the previous one on a similar database.

## `sqlite_schema`

| Parameter | Type | Default | |
|---|---|---|---|
| `path` | string | | required |
| `counts` | boolean | `false` | `COUNT(*)` per table |
| `counts_timeout_ms` | number | 60000 | per-table budget, 1–600000 |

Response fields:

| Field | |
|---|---|
| `path`, `size` | the file |
| `mtime_utc`, `mtime_local` | modification time in UTC (ISO 8601) and in the container's local time with a numeric offset, e.g. `2026-09-13 07:31:02 +03:00` |
| `sqlite3_version` | version of the binary |
| `pragmas` | `journal_mode`, `page_size`, `page_count`, `encoding`, `user_version`, `application_id` |
| `objects` | `type`, `name`, `tbl_name`, `sql` for every table, index, view and trigger, from `sqlite_master` |
| `wal_present`, `shm_present` | whether `-wal` / `-shm` exist beside the original file |
| `wal_copy`, `wal_copy_ms` | whether this call read from a private copy, and how long making it took (`null` if none) |
| `counts` | table → row count, or `null` if not requested or timed out |
| `counts_incomplete` | `null`, or `tables` (those that timed out) and one shared `note` |
| `elapsed_ms` | time for the whole call |

Row counts are off by default because `COUNT(*)` is a full table scan. Call once without `counts`, then again with `counts: true` only if you need the numbers: the DDL comes back in full either way.

`counts_timeout_ms` is a budget per table, not a pool shared across tables. It covers spawning `sqlite3` and opening the file as well as the count itself, so on a large file a very small budget can time out even a table with a handful of rows. A table that runs out is `null` in `counts` and listed in `counts_incomplete.tables`; the rest of the schema is still returned. How long a count takes depends more on the available indexes than on the row count.

## `sqlite_query`

| Parameter | Type | Default | |
|---|---|---|---|
| `path` | string | | required |
| `sql` | string | | required |
| `limit` | number | 100 | 1–1000 |
| `timeout_ms` | number | 5000 | 1–30000 |

The statement must start with `SELECT`, `WITH`, `VALUES` or `EXPLAIN`, and may end with one `;`. It runs wrapped as `SELECT * FROM (<sql>) LIMIT <limit+1>`, with the query on a line of its own. The extra row is how truncation is detected.

The statement is tokenized before `sqlite3` is started, the way SQLite's own tokenizer reads it. A `;` inside a string literal, a quoted identifier or a comment is part of the text and is accepted; a `;` anywhere else ends a statement and is refused. Bind parameters — `?`, `:x`, `@x`, `$x`, `#x` — are refused outright: `sqlite_query` has nothing to bind them to, and `$name(…)` in particular is a piece of syntax no scanner short of SQLite's own reads correctly. Unterminated literals and block comments, and unbalanced parentheses, are refused as well, because the wrapper around the query can only hold if they are balanced.

`EXPLAIN` and `EXPLAIN QUERY PLAN` are accepted as well, and what follows the keyword must itself start with `SELECT`, `WITH` or `VALUES`. The modifier is lifted out of the wrapper — `SELECT * FROM (EXPLAIN …)` is not something SQLite will parse — so the statement actually run is `EXPLAIN … SELECT * FROM (<sql>) LIMIT <limit+1>`.

Two consequences:

- The plan describes the **wrapped** statement, not the one you sent. For a composite query or an aggregate the plan gains rows the bare query would not produce, typically `CO-ROUTINE` and `SCAN (subquery-N)`.
- `limit` does not reach the plan. SQLite emits the whole listing and it is clipped afterwards, so `truncated` still tells the truth, but a very large plan runs into `OUTPUT_TOO_LARGE` with no partial result returned.

Response fields: `path`, `size`, `mtime_utc`, `mtime_local`, `wal_copy`, `wal_copy_ms`, `columns`, `rows` (array of objects), `row_count`, `truncated` (`true` when there were more rows than `limit`), `elapsed_ms`.

BLOB columns are passed through unconverted and are unreadable in JSON. Select `hex(col)` or `length(col)` instead.

## Refusals and errors

Every error starts with a code:

| Code | Meaning |
|---|---|
| `NOT_FOUND` | the path does not exist or is not a regular file |
| `NOT_SQLITE` | the first sixteen bytes are not a SQLite header; they are quoted in hex, and as ASCII when printable |
| `DOT_COMMAND` | the statement starts with `.` |
| `MALFORMED_SQL` | an unterminated string literal, quoted identifier, `[identifier]` or `/* comment`; a parenthesis with no match; a NUL character. The position is given as a character offset |
| `PARAMETERS_NOT_SUPPORTED` | a bind parameter (`?`, `:x`, `@x`, `$x`, `#x`) — there is nothing to bind it to |
| `MULTIPLE_STATEMENTS` | a `;` that ends a statement, that is, one outside a string literal, a quoted identifier or a comment; one trailing `;` is allowed |
| `INVALID_STATEMENT` | the statement does not start with `SELECT`, `WITH`, `VALUES` or `EXPLAIN`; or it starts with `EXPLAIN` and what follows is not whitespace and then a `SELECT`, `WITH` or `VALUES` of its own |
| `QUERY_TIMEOUT` | the query ran longer than `timeout_ms` (or a count longer than `counts_timeout_ms`) and was killed |
| `QUERY_TOO_LARGE` | the query needed more than 256 MiB of working memory — a large sort, `group_concat()` over many rows, `hex()` on a big BLOB |
| `OUTPUT_TOO_LARGE` | `sqlite3` produced more than 1 MiB of output; no partial result is returned |
| `HEAP_LIMIT_UNCONFIRMED` | this `sqlite3` build did not confirm the memory limit, so the query was not run |
| `WAL_PRESENT_READONLY` | the private copy of a database with a `-wal` could not be made: no space, unreadable source, or unwritable temp directory |
| `MALFORMED_OUTPUT` | `sqlite3 -json` output did not parse |
| `SQLITE_MISSING` | the `sqlite3` binary is not installed |
| `SQLITE_ERROR` | any other error from `sqlite3`, with its message |

The five statement checks — `DOT_COMMAND`, `MALFORMED_SQL`, `PARAMETERS_NOT_SUPPORTED`, `MULTIPLE_STATEMENTS`, `INVALID_STATEMENT` — all run before `sqlite3` is started. When a statement is wrong in more than one way the answer is picked by seriousness, not by position, in exactly that order. A statement whose parentheses do not balance and which also carries a stray `;` is reported as malformed, which is the more useful of the two things to be told.

Where the tokenizer and SQLite could disagree, it refuses rather than accepts: `/*` as the last two characters of a query is division to SQLite and an unterminated comment here.

An unknown parameter name is an error, not a silent no-op.

## Keep a few reference figures

The first time you read a database, note a row count, a distinct count or a total, anything cheap to recompute. Re-run the same query after updating the app or after the file is replaced, and compare. A wrong answer from a database looks like a normal result; reference figures are what catch it.
