#!/usr/bin/env bash
# Builds throwaway test databases for sqlite_schema / sqlite_query
# (filesystem_mcp/sqlite.js). Output is regenerated on every run — nothing
# here is committed, these are binaries that would just rot in the repo.
#
# Needs a real `sqlite3` on PATH. No FIFO, no other POSIX-only plumbing — a
# plain pipe with a trailing `sleep` keeps the writer's stdin open, which
# works the same on Linux, macOS and Git-Bash/MSYS on Windows.
#
# Usage: test/make-fixtures.sh [output-dir]   (default: test/fixtures)

set -euo pipefail

OUT="${1:-$(dirname "$0")/fixtures}"
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
# hand at /media/VAULT/tmp/bluecoins-schema.sql. Missing input is not "skip
# this fixture", it is "fail the run", same as every other fixture here.
SRC="/media/VAULT/tmp/bluecoins-schema.sql"
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

# --- self-check: hard_heap_limit actually stops an unbounded recursive CTE -
# sitting under an aggregate. SELECT * FROM (<sql>) LIMIT n, the wrapper
# sqlite_query puts around every call, does not bound this shape: max() has to
# consume the whole (infinite) input before it can produce its one output row,
# so the outer LIMIT never gets a chance to matter. Without hard_heap_limit
# this grows in memory until timeout_ms (up to 30s) or the OOM killer takes
# the whole add-on process with it.
#
# This runs sqlite.js itself (not raw sqlite3) because the thing being checked
# is OUR error-code mapping (QUERY_TOO_LARGE), not just the underlying SQLite
# behaviour. It asserts the error is actually raised — it does not skip when
# the limiter is unavailable, and it will fail on anything other than exactly
# QUERY_TOO_LARGE. timeout_ms below is 3s, not the tool's own 30s ceiling: on
# a working limiter (Alpine) hard_heap_limit trips almost immediately, so 3s
# changes nothing about what actually passes — it only bounds how long this
# check is allowed to run an unbounded-memory query on a box where the
# limiter does NOT work (this one, confirmed — see HARD_HEAP_LIMIT_BYTES in
# sqlite.js), where it will exhaust the 3s and correctly report FATAL. That is
# a true red, not a reason to soften the assertion — the add-on only ever
# runs on Alpine, which is where this is meant to actually pass.
CHECK_JS="$OUT/.hard-heap-limit-check.js"
cat > "$CHECK_JS" <<'JS'
const path = require('path');
const S = require(path.join(process.env.SQLITE_MODULE_DIR, 'sqlite.js'));
const dbPath = path.join(process.env.FIXTURES_DIR, 'empty.db');
(async () => {
  try {
    await S.query(
      dbPath,
      'SELECT max(n) FROM (WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM c) SELECT n FROM c)',
      { timeout_ms: 3000 }
    );
    console.error('FATAL: unbounded recursive CTE under an aggregate did not error at all — hard_heap_limit is not stopping it');
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
SQLITE_MODULE_DIR="$(cd "$(dirname "$0")/../filesystem_mcp" && pwd)" FIXTURES_DIR="$OUT" node "$CHECK_JS"
CHECK_RC=$?
rm -f "$CHECK_JS"
[ "$CHECK_RC" -eq 0 ] \
  || { echo "make-fixtures: FATAL — hard_heap_limit self-check failed (see above)" >&2; exit 1; }

echo "Done: $(ls "$OUT" | wc -l) fixture file(s) in $OUT"
