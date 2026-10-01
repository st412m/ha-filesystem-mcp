#!/bin/sh
# Toolchain check of the add-on. Runs twice:
#   /toolchain-check.sh build    - at image build: fails if a major version
#                                  changed or the PDF or SQLite pipeline fails
#   /toolchain-check.sh runtime  - at start: prints the version banner to the log
set -eu

# Expected major versions. Patch releases within the Alpine branch are fine;
# a different major stops the build.
EXPECT_NODE_MAJOR=22
EXPECT_POPPLER_MAJOR=25
EXPECT_SQLITE_MAJOR=3

MANIFEST=/toolchain.txt

collect() {
  NODE_V=$(node -v 2>/dev/null | sed 's/^v//' || echo '?')
  POPPLER_V=$(pdftotext -v 2>&1 | sed -n 's/^pdftotext version \([0-9][0-9.]*\).*/\1/p' | head -1)
  [ -n "${POPPLER_V:-}" ] || POPPLER_V='?'
  SQLITE_V=$(sqlite3 -version 2>/dev/null | awk '{print $1}')
  [ -n "${SQLITE_V:-}" ] || SQLITE_V='?'
}

major() { echo "$1" | sed 's/[.-].*//'; }

guard() {
  rc=0
  if [ "$(major "$NODE_V")" != "$EXPECT_NODE_MAJOR" ]; then
    echo "TOOLCHAIN GUARD: nodejs $NODE_V, expected major $EXPECT_NODE_MAJOR" >&2; rc=1
  fi
  if [ "$(major "$POPPLER_V")" != "$EXPECT_POPPLER_MAJOR" ]; then
    echo "TOOLCHAIN GUARD: poppler $POPPLER_V, expected major $EXPECT_POPPLER_MAJOR" >&2; rc=1
  fi
  if [ "$(major "$SQLITE_V")" != "$EXPECT_SQLITE_MAJOR" ]; then
    echo "TOOLCHAIN GUARD: sqlite3 $SQLITE_V, expected major $EXPECT_SQLITE_MAJOR" >&2; rc=1
  fi
  if [ "$rc" != 0 ]; then
    echo "" >&2
    echo "Build stopped: Alpine shipped a toolchain the add-on has not been" >&2
    echo "tested against. Run read_pdf_text/read_pdf_page/sqlite_query by hand," >&2
    echo "make sure everything works, then update EXPECT_*_MAJOR in toolchain-check.sh." >&2
    exit 1
  fi
}

# Smoke test of exactly what the server runs: pdfinfo (pdfPageCount),
# pdftoppm with the server's flags (read_pdf_page, read_media_file) and
# pdftotext -layout (read_pdf_text). The PDF is generated here: a valid
# one-line document with a marker, xref offsets precomputed.
smoke() {
  T=$(mktemp -d)
  # shellcheck disable=SC2064
  trap "rm -rf '$T'" EXIT

  cat > "$T/smoke.pdf" << 'PDF_EOF'
%PDF-1.4
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [3 0 R] /Count 1 >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 80] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>
endobj
4 0 obj
<< /Length 43 >>
stream
BT /F1 12 Tf 20 40 Td (VMCP-SMOKE-OK) Tj ET
endstream
endobj
5 0 obj
<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>
endobj
xref
0 6
0000000000 65535 f 
0000000009 00000 n 
0000000058 00000 n 
0000000115 00000 n 
0000000240 00000 n 
0000000333 00000 n 
trailer
<< /Size 6 /Root 1 0 R >>
startxref
403
%%EOF
PDF_EOF

  # pdfinfo: the server parses the "Pages:" line in pdfPageCount()
  pdfinfo "$T/smoke.pdf" | grep -Eq '^Pages:[[:space:]]+1$' \
    || { echo "SMOKE FAIL: pdfinfo did not report Pages: 1" >&2; exit 1; }

  # pdftoppm: exactly the flags of pdfPageToImage() in server.js. stderr is
  # discarded: the image has no fonts, so poppler warns that it cannot find
  # Helvetica and renders with a substitute. Exit code, file and JPEG header
  # are checked below.
  pdftoppm -jpeg -r 120 -scale-to 1400 -f 1 -l 1 "$T/smoke.pdf" "$T/page" 2>/dev/null \
    || { echo "SMOKE FAIL: pdftoppm failed" >&2; exit 1; }
  J=$(ls "$T"/page*.jpg 2>/dev/null | head -1)
  [ -n "$J" ] && [ -s "$J" ] || { echo "SMOKE FAIL: pdftoppm produced no JPEG" >&2; exit 1; }
  head -c 2 "$J" | od -An -tx1 | tr -d ' \n' | grep -qi 'ffd8' \
    || { echo "SMOKE FAIL: pdftoppm output is not a JPEG" >&2; exit 1; }

  # pdftotext: exactly the flags of pdfToText() in server.js
  pdftotext -layout -f 1 -l 1 "$T/smoke.pdf" - | grep -q 'VMCP-SMOKE-OK' \
    || { echo "SMOKE FAIL: pdftotext did not extract the marker" >&2; exit 1; }

  # sqlite3: the command line runSqlite() in sqlite.js uses, including
  # -cmd "PRAGMA hard_heap_limit=...".
  sqlite3 "$T/smoke.db" "CREATE TABLE t(x); INSERT INTO t VALUES (1),(2),(3);" \
    || { echo "SMOKE FAIL: could not create the test database" >&2; exit 1; }
  HHL_OUT=$(sqlite3 -cmd "PRAGMA hard_heap_limit=268435456;" -readonly -safe -json "$T/smoke.db" "SELECT COUNT(*) AS n FROM t")
  # The pragma echo is the only sign that this sqlite3 build accepted the
  # limit: an unknown PRAGMA name does nothing, silently. The echo comes back
  # either as JSON or as the bare number, so the value is checked, not one
  # form (same as HEAP_LIMIT_ECHO_CANDIDATES in sqlite.js).
  echo "$HHL_OUT" | grep -Eq '^(\[\{"hard_heap_limit":268435456\}\]|268435456([^0-9]|$))' \
    || { echo "SMOKE FAIL: hard_heap_limit not confirmed by the pragma echo (got: $HHL_OUT)" >&2; exit 1; }
  echo "$HHL_OUT" | grep -q '"n":3' \
    || { echo "SMOKE FAIL: sqlite3 -readonly -safe -json did not return the expected COUNT(*)" >&2; exit 1; }

  # EXPLAIN, through the argv sqlite.js uses, including -cmd ".explain off".
  # Without it the CLI ignores -json for EXPLAIN and EXPLAIN QUERY PLAN and
  # draws a fixed-column text table, which sqlite.js reports as
  # MALFORMED_OUTPUT. A dot-command refused by -safe does not change the exit
  # status, so the output is checked: one line that opens the JSON array and
  # carries a quoted column name.
  EXP_OUT=$(sqlite3 -cmd "PRAGMA hard_heap_limit=268435456;" -cmd ".explain off" -readonly -safe -json "$T/smoke.db" "EXPLAIN SELECT 1 AS x")
  echo "$EXP_OUT" | grep -q '^\[{.*"opcode"' \
    || { echo "SMOKE FAIL: EXPLAIN did not come back as JSON — .explain off had no effect (got: $(echo "$EXP_OUT" | head -3 | tr '\n' ' '))" >&2; exit 1; }

  # -safe must refuse ATTACH; otherwise a query could read any file on the
  # disk past the vault check. A successful ATTACH fails the build.
  if sqlite3 -readonly -safe "$T/smoke.db" "ATTACH '/etc/passwd' AS x;" >/dev/null 2>&1; then
    echo "SMOKE FAIL: -safe did not block ATTACH" >&2; exit 1
  fi
}

collect
case "${1:-runtime}" in
  build)
    guard
    smoke
    {
      echo "built: $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
      echo "nodejs: $NODE_V"
      echo "poppler(pdftotext/pdftoppm/pdfinfo): $POPPLER_V"
      echo "pdf-pipeline(pdfinfo+pdftoppm+pdftotext): ok"
      echo "sqlite3: $SQLITE_V"
      echo "sqlite-pipeline(readonly+safe+json, ATTACH blocked): ok"
      echo "sqlite-explain(.explain off -> json): ok"
    } > "$MANIFEST"
    echo "Toolchain OK -> $(tr '\n' '; ' < "$MANIFEST")"
    ;;
  runtime)
    echo "node $NODE_V | poppler $POPPLER_V | sqlite3 $SQLITE_V"
    ;;
  *)
    echo "usage: $0 build|runtime" >&2; exit 2
    ;;
esac
