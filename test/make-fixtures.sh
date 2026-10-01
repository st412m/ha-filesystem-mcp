#!/bin/sh
# Builds throwaway test databases for sqlite_schema / sqlite_query
# (filesystem_mcp/sqlite.js). Output is regenerated on every run and is not
# committed.
#
# Needs sqlite3 and node on PATH. Plain sh: runs on Linux, macOS and
# Git-Bash/MSYS on Windows.
#
# VAULT_PATH is required. The self-checks below read the fixtures through the
# vault check, so the output directory must be inside the vault.
#
#   VAULT_PATH=/media/VAULT test/make-fixtures.sh
#   VAULT_PATH=/share/vault test/make-fixtures.sh /share/vault/tmp/fixtures
#
# Usage: test/make-fixtures.sh [output-dir]   (default: $VAULT_PATH/tmp/fixtures)

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

# --- bluecoins_schema.db: a real-world DDL dump (schema only, no data) -----
# Covers three things no other fixture does:
#   1. Block comments inside CREATE TABLE: sqlite_master.sql is returned raw
#      by sqlite_schema, and the response must still be valid JSON.
#   2. sqlite_sequence, created by SQLite for an AUTOINCREMENT column: the
#      'sqlite_%' exclusion filter and the counts:true skip.
#   3. Upper-case table names already quoted in the source DDL: a different
#      path through quoteIdent() than idents.db's spaces and reserved words.
# The source is not generated: put the schema dump at
# $VAULT_PATH/tmp/bluecoins-schema.sql. A missing source fails the run.
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
# WAL-mode database: the .db and its -wal copied while the writer still holds
# its connection open. It reads back under -readonly -safe, because sqlite3
# may create the -shm file itself in a writable directory
# (sqlite.org/wal.html). It does not reproduce WAL_PRESENT_READONLY, which
# needs a directory without write access; that branch has no fixture.
#
# Closing the connection would checkpoint the WAL into the main file and
# leave nothing to copy. The `sleep 5` inside the pipe keeps the stdin of
# sqlite3 open, so it does not see EOF and close the connection until five
# seconds later; the files are copied in that window.
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
sleep 2   # let sqlite3 finish executing before its files are read

if [ ! -f "$WORK/live.db-wal" ]; then
  echo "make-fixtures: WARN — no -wal sidecar appeared; wal_hotcopy fixture was not produced." >&2
  wait "$HOLDER_PID" 2>/dev/null || true
  # A missing fixture fails the run instead of finishing green without it.
  echo "make-fixtures: FATAL — wal_hotcopy fixture could not be built" >&2
  exit 1
fi

cp "$WORK/live.db"     "$OUT/wal_hotcopy.db"
cp "$WORK/live.db-wal" "$OUT/wal_hotcopy.db-wal"
# The same main file without its -wal: every write still sits in the WAL, so
# a reader given only wal_hotcopy_nowal.db sees a database with no tables.
cp "$WORK/live.db"     "$OUT/wal_hotcopy_nowal.db"

wait "$HOLDER_PID" 2>/dev/null || true

# Self-check: wal_hotcopy.db reads correctly under the flags sqlite.js uses.
GOT=$(sqlite3 -readonly -safe -json "$OUT/wal_hotcopy.db" "SELECT COUNT(*) AS n FROM t")
echo "$GOT" | grep -q '"n":3' \
  || { echo "make-fixtures: FATAL — wal_hotcopy.db did not read back 3 rows under -readonly -safe (got: $GOT)" >&2; exit 1; }

# --- self-check: a WAL-journaled database read through sqlite.js ----------
# Opening a database whose content lives only in an uncheckpointed -wal via
# `immutable=1` silently skips the journal: `sqlite_master` has no tables and
# a query fails with "no such table". This check calls query() from
# sqlite.js, prepareOpen() included: n confirms the data came through, and
# wal_copy === true confirms the copy path was taken instead of immutable=1.
CHECK_JS="$OUT/.wal-copy-check.js"
cat > "$CHECK_JS" <<'JS'
const path = require('path');
const S = require(path.join(process.env.SQLITE_MODULE_DIR, 'sqlite.js'));
const SP = require(path.join(process.env.SQLITE_MODULE_DIR, 'safepath.js'));
// sqlite.js takes a path checked against the vault root, not a string. A
// fixture directory outside VAULT_PATH is refused here as through a tool.
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

# --- self-check: hard_heap_limit stops a large allocation -----------------
# hex(zeroblob(200000000)) forces one ~400 MB text buffer (2 bytes of hex per
# source byte), over the 256 MiB (268435456 byte) limit. One allocation, sized
# up front: fast and bounded even where the limit does not work.
#
# Runs sqlite.js itself, because the error-code mapping is what is checked:
# anything other than exactly QUERY_TOO_LARGE fails, and nothing is skipped.
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
