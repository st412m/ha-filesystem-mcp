#!/bin/sh
# Builds throwaway test databases for sqlite_schema / sqlite_query
# (filesystem_mcp/sqlite.js). Output is regenerated on every run — nothing
# here is committed, these are binaries that would just rot in the repo.
#
# Needs a real `sqlite3` on PATH. No FIFO, no other POSIX-only plumbing — a
# plain pipe with a trailing `sleep` keeps the writer's stdin open, which
# works the same on Linux, macOS and Git-Bash/MSYS on Windows.
#
# /media/VAULT is one particular vault_path, not a constant of this add-on —
# anyone else's vault lives somewhere else (a tester's was on a Raspberry Pi,
# under a different mount entirely). VAULT_PATH is required, not defaulted:
#
#   VAULT_PATH=/media/VAULT test/make-fixtures.sh
#   VAULT_PATH=/share/vault test/make-fixtures.sh /share/vault/tmp/fixtures
#
# Usage: test/make-fixtures.sh [output-dir]   (default: $VAULT_PATH/tmp/fixtures)
#
# 2.7.2: converted from bash to plain sh (the add-on image has no bash; every
# prior run of this script started with `apk add bash` by hand first). No
# bashism survived that couldn't be dropped without losing meaning — the only
# one removed is `pipefail`, and nothing here relies on it: every pipe below
# ends in the command whose exit status actually matters, which plain `set -e`
# already catches.

set -eu

: "${VAULT_PATH:?VAULT_PATH must be set — see the usage note above}"
OUT="${1:-$VAULT_PATH/tmp/fixtures}"
mkdir -p "$OUT"

command -v sqlite3 >/dev/null 2>&1 || { echo "make-fixtures: sqlite3 not found on PATH" >&2; exit 1; }

echo "Writing fixtures to $OUT"

# --- empty.db: valid header, zero tables --------------------------------
rm -f "$OUT/empty.db"
sqlite3 "$OUT/empty.db" "CREATE TABLE _init(x); DROP TABLE _init;"

# --- weird.db: BLOB, NULL, unicode, negative numbers, a long string -----
rm -f "$OUT/weird.db"
sqlite3 "$OUT/weird.db" <<'SQL'
CREATE TABLE weird (
  id   INTEGER PRIMARY KEY,
  blob BLOB,
  nul  INTEGER,
  uni  TEXT,
  neg  INTEGER,
  long TEXT
);
INSERT INTO weird (id, blob, nul, uni, neg, long) VALUES
  (1, X'0001FF7E', NULL, 'юникод 中文 🎉', -12345, hex(zeroblob(3000))),
  (2, NULL, NULL, '', 0, ''),
  (3, X'00', 1, 'plain', -9223372036854775808, 'short');
SQL

# --- big.db: two million rows, generated with a recursive CTE -----------
rm -f "$OUT/big.db"
sqlite3 "$OUT/big.db" <<'SQL'
CREATE TABLE big (n INTEGER PRIMARY KEY, v TEXT);
INSERT INTO big (n, v)
  WITH RECURSIVE c(n) AS (
    SELECT 1
    UNION ALL
    SELECT n + 1 FROM c WHERE n < 2000000
  )
  SELECT n, 'row-' || n FROM c;
SQL

# --- idents.db: table/column names with spaces and reserved words -------
rm -f "$OUT/idents.db"
sqlite3 "$OUT/idents.db" <<'SQL'
CREATE TABLE "select" (
  "group"       INTEGER,
  "order by"    TEXT,
  "weird name!" TEXT
);
INSERT INTO "select" VALUES (1, 'a', 'x'), (2, 'b', 'y');
SQL

# --- views.db: a generated column and a view -----------------------------
rm -f "$OUT/views.db"
sqlite3 "$OUT/views.db" <<'SQL'
CREATE TABLE base (
  a INTEGER,
  b INTEGER,
  c INTEGER GENERATED ALWAYS AS (a + b) STORED
);
INSERT INTO base (a, b) VALUES (1, 2), (3, 4), (-1, 1);
CREATE VIEW base_view AS SELECT a, b, c FROM base WHERE a > 0;
SQL

# --- notsqlite.db: garbage with a .db extension --------------------------
printf 'this is not a sqlite database\n' > "$OUT/notsqlite.db"

# --- real.fydb: a genuine database under an unrelated extension ---------
rm -f "$OUT/real.fydb"
sqlite3 "$OUT/real.fydb" "CREATE TABLE t(x); INSERT INTO t VALUES (1), (2);"

# --- bluecoins_schema.db: a real-world DDL dump (schema only, no data), ------
# built from a Bluecoins backup a tester sent in. Covers three things no other
# fixture does:
#   1. Block comments inside CREATE TABLE — sqlite_master.sql is returned raw
#      in sqlite_schema, so these land in the JSON response verbatim; this
#      checks the response still assembles as valid JSON, not that we do
#      anything to the comments (we don't touch them at all).
#   2. sqlite_sequence, created by SQLite itself for an AUTOINCREMENT column —
#      exercises the 'sqlite\_%' exclusion filter and the counts:true skip for
#      real for the first time; every other fixture happens to have no
#      AUTOINCREMENT table, so this branch has run zero times before it.
#   3. Table names in upper case and already quoted in the source DDL — a
#      different path through quoteIdent() than idents.db's spaces/reserved
#      words.
# The source file is not generated here — it is a real schema, dropped in by
# hand at $VAULT_PATH/tmp/bluecoins-schema.sql. Missing input is not "skip
# this fixture", it is "fail the run", same as every other fixture here.
SRC="$VAULT_PATH/tmp/bluecoins-schema.sql"
rm -f "$OUT/bluecoins_schema.db"
if [ ! -f "$SRC" ]; then
  echo "make-fixtures: FATAL — $SRC not found; bluecoins_schema fixture could not be built" >&2
  exit 1
fi
sqlite3 -bail "$OUT/bluecoins_schema.db" < "$SRC" \
  || { echo "make-fixtures: FATAL — sqlite3 failed to load $SRC into bluecoins_schema.db" >&2; exit 1; }
TABLE_COUNT=$(sqlite3 "$OUT/bluecoins_schema.db" "SELECT COUNT(*) FROM sqlite_master WHERE type='table'")
[ "${TABLE_COUNT:-0}" -gt 0 ] 2>/dev/null \
  || { echo "make-fixtures: FATAL — bluecoins_schema.db has no tables after loading $SRC" >&2; exit 1; }

# --- wal_hotcopy.db(+-wal) / wal_hotcopy_nowal.db: a hot copy of a live -
# WAL-mode database. What this proves: a copy taken while the writer still
# holds its connection open (.db + .db-wal together) reads back correctly
# under -readonly -safe, because sqlite3 is allowed to create the -shm file
# itself as long as the containing directory is writable (sqlite.org/wal.html)
# — which it normally is. It does NOT reproduce WAL_PRESENT_READONLY: that
# needs the directory itself to deny write access (a read-only bind-mount, a
# share mounted without write permission, a full volume) — not reproducible
# synthetically, and not under root, which ignores Unix permission bits. See
# the matching note in sqlite.js; that branch has no fixture here.
#
# Reproduction: set journal_mode=WAL, write rows, copy the .db together with
# its -wal WHILE the writing connection is still open — closing it first lets
# SQLite auto-checkpoint (checkpoint-on-last-close, independent of
# wal_autocheckpoint) and fold the WAL back into the main file, leaving
# nothing to copy. The trailing `sleep 5` inside the pipe subshell is what
# keeps stdin open: sqlite3 has already executed the three statements above
# it, but doesn't see EOF (and so doesn't close the connection) until the
# subshell itself exits five seconds later. We copy the files during that
# window.
rm -f "$OUT/wal_hotcopy.db" "$OUT/wal_hotcopy.db-wal" "$OUT/wal_hotcopy_nowal.db"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

{
  cat <<'SQL'
PRAGMA journal_mode=WAL;
CREATE TABLE t (x INTEGER, note TEXT);
INSERT INTO t VALUES (1,'a'), (2,'b'), (3,'c');
SQL
  sleep 5
} | sqlite3 "$WORK/live.db" &
HOLDER_PID=$!
sleep 2   # let sqlite3 finish executing before we read its files

if [ ! -f "$WORK/live.db-wal" ]; then
  echo "make-fixtures: WARN — no -wal sidecar appeared; wal_hotcopy fixture was not produced." >&2
  wait "$HOLDER_PID" 2>/dev/null || true
  # A missing fixture here is not "test skipped", it is "test lied" — fail
  # the whole run instead of finishing green with this fixture silently gone.
  echo "make-fixtures: FATAL — wal_hotcopy fixture could not be built" >&2
  exit 1
fi

cp "$WORK/live.db"     "$OUT/wal_hotcopy.db"
cp "$WORK/live.db-wal" "$OUT/wal_hotcopy.db-wal"
# Same main file, but WITHOUT its -wal: demonstrates data loss, not the
# readonly error. The CREATE TABLE/INSERT above never got checkpointed into
# the main file (all of it still sat in the WAL when we copied), so a reader
# given only wal_hotcopy_nowal.db sees a table-less database, not an error.
cp "$WORK/live.db"     "$OUT/wal_hotcopy_nowal.db"

wait "$HOLDER_PID" 2>/dev/null || true

# Self-check: wal_hotcopy.db must read correctly under the exact flags
# sqlite.js uses. That is this fixture's actual job — proving the common case
# (hot copy, writable directory) stays a normal read, not an error.
GOT=$(sqlite3 -readonly -safe -json "$OUT/wal_hotcopy.db" "SELECT COUNT(*) AS n FROM t")
echo "$GOT" | grep -q '"n":3' \
  || { echo "make-fixtures: FATAL — wal_hotcopy.db did not read back 3 rows under -readonly -safe (got: $GOT)" >&2; exit 1; }

# --- self-check: reading a WAL-journaled database THROUGH THE TOOL must -----
# come back with real data, not a quietly wrong empty schema. Measured on the
# real Alpine binary (sqlite-spec-272.md §1/§3): opening a database whose
# schema and rows live entirely in an uncheckpointed -wal via `immutable=1`
# does not error and does not warn — it just silently skips the journal's
# content, so `sqlite_master` comes back with no tables and any query against
# one of them fails as "no such table", indistinguishable from a typo. The raw
# check just above proves the fixture file itself is fine under
# `-readonly -safe`; this one instead calls sqlite.js's own query() — the
# actual code path a tool call takes, prepareOpen() included — and would fail
# if a future change ever let `immutable=1` reach a database with a real
# journal again. row_count/n confirm the data came through; wal_copy=== true
# confirms it went through the copy path rather than immutable, which is the
# part that actually matters here.
CHECK_JS="$OUT/.wal-copy-check.js"
cat > "$CHECK_JS" <<'JS'
const path = require('path');
const S = require(path.join(process.env.SQLITE_MODULE_DIR, 'sqlite.js'));
const SP = require(path.join(process.env.SQLITE_MODULE_DIR, 'safepath.js'));
// Since 2.8.0 sqlite.js takes a checked path, not a string — the same one the
// server hands it, resolved against the vault root. A fixture directory
// outside VAULT_PATH is refused here exactly as it would be through a tool.
const dbPath = SP.createResolver(process.env.VAULT_PATH)
  .resolveSafe(path.join(process.env.FIXTURES_DIR, 'wal_hotcopy.db'));
(async () => {
  try {
    const res = await S.query(dbPath, 'SELECT COUNT(*) AS n FROM t', { timeout_ms: 15000 });
    if (res.wal_copy !== true) {
      console.error('FATAL: wal_hotcopy.db was not read via the copy path (wal_copy=' + res.wal_copy + ') — immutable=1 may have been used against a real journal');
      process.exit(1);
    }
    const n = res.rows && res.rows[0] && res.rows[0].n;
    if (n !== 3) {
      console.error('FATAL: expected 3 rows through the tool, got: ' + JSON.stringify(res.rows));
      process.exit(1);
    }
    console.error('wal-copy check OK: row data came through (n=3), wal_copy=true');
  } catch (e) {
    console.error('FATAL: sqlite_query on wal_hotcopy.db raised instead of returning rows: ' + e.message);
    process.exit(1);
  }
})();
JS
SQLITE_MODULE_DIR="$(cd "$(dirname "$0")/../filesystem_mcp" && pwd)" FIXTURES_DIR="$OUT" VAULT_PATH="$VAULT_PATH" node "$CHECK_JS"
CHECK_RC=$?
rm -f "$CHECK_JS"
[ "$CHECK_RC" -eq 0 ] \
  || { echo "make-fixtures: FATAL — wal-copy check failed (see above)" >&2; exit 1; }

# --- self-check: hard_heap_limit actually stops a query that allocates a ---
# lot in one place: hex(zeroblob(200000000)) forces a single ~400 MB text
# buffer (200 MB source blob, 2 bytes of hex per source byte), comfortably
# over the 256 MiB (268435456 byte) limit. This replaces an earlier version
# that used an unbounded recursive CTE under max() (SELECT max(n) FROM (WITH
# RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM c) SELECT n FROM c)):
# measured on the real Alpine binary, that query used sys 0.05s over a full
# 20s run — an infinite CPU-bound COUNT, not a memory allocation, and 8 MiB
# was not enough to make it error either. timeout_ms was catching it, and
# QUERY_TIMEOUT was always the correct answer for that shape, not a defect —
# see sqlite-spec.md for the corrected premise. hex(zeroblob(N)) is what the
# spec's own examples of real memory pressure look like (a big sort,
# group_concat over many rows, hex() on a large BLOB): one allocation, sized
# up front, nothing to iterate — so it is fast and bounded even where the
# limiter does not work (confirmed on this machine: resolves in ~100ms
# instead of hanging), unlike the CTE it replaces.
#
# This runs sqlite.js itself (not raw sqlite3) because the thing being checked
# is OUR error-code mapping (QUERY_TOO_LARGE), not just the underlying SQLite
# behaviour. It asserts the error is actually raised — it does not skip when
# the limiter is unavailable, and it will fail on anything other than exactly
# QUERY_TOO_LARGE.
CHECK_JS="$OUT/.hard-heap-limit-check.js"
cat > "$CHECK_JS" <<'JS'
const path = require('path');
const S = require(path.join(process.env.SQLITE_MODULE_DIR, 'sqlite.js'));
const SP = require(path.join(process.env.SQLITE_MODULE_DIR, 'safepath.js'));
const dbPath = SP.createResolver(process.env.VAULT_PATH)
  .resolveSafe(path.join(process.env.FIXTURES_DIR, 'empty.db'));
(async () => {
  try {
    await S.query(
      dbPath,
      'SELECT length(hex(zeroblob(200000000))) AS n',
      { timeout_ms: 15000 }
    );
    console.error('FATAL: a ~400 MB single allocation did not error at all — hard_heap_limit is not stopping it');
    process.exit(1);
  } catch (e) {
    if (!/^QUERY_TOO_LARGE:/.test(e.message)) {
      console.error('FATAL: expected QUERY_TOO_LARGE, got: ' + e.message);
      process.exit(1);
    }
    console.error('hard_heap_limit check OK: ' + e.message);
  }
})();
JS
SQLITE_MODULE_DIR="$(cd "$(dirname "$0")/../filesystem_mcp" && pwd)" FIXTURES_DIR="$OUT" VAULT_PATH="$VAULT_PATH" node "$CHECK_JS"
CHECK_RC=$?
rm -f "$CHECK_JS"
[ "$CHECK_RC" -eq 0 ] \
  || { echo "make-fixtures: FATAL — hard_heap_limit self-check failed (see above)" >&2; exit 1; }

echo "Done: $(ls "$OUT" | wc -l) fixture file(s) in $OUT"
