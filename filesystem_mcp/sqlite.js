'use strict';
/**
 * Vault MCP — read-only SQLite inspection
 *
 * Two tools, schema-neutral: sqlite_schema() looks at what is in the file,
 * sqlite_query() runs exactly one read-only statement. Neither interprets the
 * data — no table or column name anywhere in this file is special-cased.
 *
 * Protection against writes and against escaping the vault through SQL rests
 * on three things: `-readonly` (SQLITE_OPEN_READONLY), `-safe` (disables
 * ATTACH, .shell, .system, .open, writefile(), edit(), load_extension(),
 * fts3_tokenizer() — ATTACH matters most, since without it a query reads any
 * file on disk regardless of the vault's own zone check), and scanSql(), which
 * tokenizes the statement before sqlite3 is started.
 *
 * The `SELECT * FROM (<sql>) LIMIT <n>` wrapper is not one of them: a wrapper
 * can be closed from the inside (`SELECT 1 AS x) ; SELECT 2 AS y /*`). It gives
 * a row limit, truncation detection and a row-producing shape, and is safe to
 * build only because the scanner guarantees balanced parentheses, closed
 * comments and no second statement.
 *
 * How the file is opened is a separate concern: a plain `-readonly` open of a
 * WAL-mode database creates `-shm` and `-wal` siblings next to it, which a
 * synced folder then propagates. See prepareOpen() (immutable URI or a private
 * copy).
 *
 * schema()/query() do no containment check of their own: `p` must be a path
 * produced by safepath.js, and pathOf() refuses anything else with
 * UNVERIFIED_PATH before a byte is read.
 *
 * Past the entry point the path is an ordinary string again: this module
 * derives -wal/-shm siblings and a temp copy from it, and none of those are
 * vault paths to be checked.
 *
 * Called the same way server.js calls pdftotext/pdftoppm for read_pdf_text/
 * read_pdf_page: execFile with an argv array (SQL is one argv element, never
 * shell-interpolated), no npm dependency.
 */

const { execFile, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const SP = require('./safepath');

const SQLITE_BIN = 'sqlite3';
const SQLITE_HEADER = 'SQLite format 3\0'; // exactly 16 bytes

const DEFAULT_LIMIT = 100, MAX_LIMIT = 1000;
const DEFAULT_TIMEOUT_MS = 5000, MAX_TIMEOUT_MS = 30000;
const DEFAULT_COUNTS_TIMEOUT_MS = 60000, MAX_COUNTS_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_STDOUT_BYTES = 1024 * 1024; // 1 MiB ceiling on sqlite3's stdout

// Working-memory limit of every sqlite3 call (PRAGMA hard_heap_limit; off by
// default in SQLite). A query that allocates past it fails with
// QUERY_TOO_LARGE instead of growing until the process is killed. 256 MiB,
// fixed, not a tool parameter: it applies to every query and every COUNT(*).
const HARD_HEAP_LIMIT_BYTES = 268435456;

const STATEMENT_KEYWORDS = ['SELECT', 'WITH', 'VALUES', 'EXPLAIN'];

// Tool option keys, identical to the inputSchema property names in server.js.
// An unrecognized key is an error (assertKnownOptions()).
const SCHEMA_OPTION_KEYS = ['counts', 'counts_timeout_ms'];
const QUERY_OPTION_KEYS = ['limit', 'timeout_ms'];

function assertKnownOptions(opts, allowed, toolName) {
  const unknown = Object.keys(opts).filter(k => !allowed.includes(k));
  if (unknown.length)
    throw new Error(`unknown option(s) for ${toolName}: ${unknown.join(', ')} — accepted: ${allowed.join(', ')}`);
}

// One row, six columns, one spawn: each pragma is used as a table-valued
// function (SQLite 3.16.0+), cross-joined.
const PRAGMA_QUERY =
  'SELECT * FROM pragma_journal_mode(), pragma_page_size(), pragma_page_count(), ' +
  'pragma_encoding(), pragma_user_version(), pragma_application_id()';

const SQLITE_MASTER_QUERY =
  "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY type, name";

function clampInt(v, def, min, max, name) {
  if (v === undefined || v === null || v === '') return def;
  const n = typeof v === 'string' ? parseInt(v, 10) : v;
  if (typeof n !== 'number' || !Number.isFinite(n)) throw new Error(`${name} must be a number`);
  const t = Math.trunc(n);
  if (t < min || t > max) throw new Error(`${name} must be between ${min} and ${max}`);
  return t;
}

// The container's local time (its TZ) with a numeric offset, from plain Date
// getters: no Intl or tz-data dependency.
function toLocalOffsetString(d) {
  const offMin = -d.getTimezoneOffset();
  const sign = offMin >= 0 ? '+' : '-';
  const abs = Math.abs(offMin);
  const p2 = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ` +
         `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())} ` +
         `${sign}${p2(Math.floor(abs / 60))}:${p2(abs % 60)}`;
}

function quoteIdent(name) {
  return '"' + String(name).replace(/"/g, '""') + '"';
}

function assertRegularFile(p) {
  let st;
  try { st = fs.statSync(p); }
  catch (e) {
    if (e.code === 'ENOENT') throw new Error(`NOT_FOUND: ${p} does not exist`);
    throw e;
  }
  if (!st.isFile()) throw new Error(`NOT_FOUND: ${p} is not a regular file`);
  return st;
}

// null unless every byte is printable ASCII: binary data gets no ASCII
// rendering.
function asciiIfPrintable(buf) {
  let s = '';
  for (const b of buf) {
    if (b < 0x20 || b > 0x7e) return null;
    s += String.fromCharCode(b);
  }
  return s;
}

// The file type is decided by the first 16 bytes, never by the extension.
function checkSqliteHeader(p) {
  const fd = fs.openSync(p, 'r');
  try {
    const buf = Buffer.alloc(16);
    const n = fs.readSync(fd, buf, 0, 16, 0);
    const head = buf.subarray(0, n);
    if (n < 16 || head.toString('latin1') !== SQLITE_HEADER) {
      const hex = head.toString('hex');
      const ascii = asciiIfPrintable(head);
      const shown = ascii ? `${hex} ("${ascii}")` : hex;
      throw new Error(`NOT_SQLITE: ${p} is not a SQLite database — first ${n} byte(s): ${shown}`);
    }
  } finally {
    fs.closeSync(fd);
  }
}

// ---------------------------------------------------------------------------
// Where to open the file from: the original path via an `immutable=1` URI, or
// a private copy of it plus its `-wal`. Decided once per tool call (by
// schema()/query(), not by runSqlite()): sqlite_schema with counts:true spawns
// sqlite3 once per table, and the file is copied once.
// ---------------------------------------------------------------------------

// Percent-encodes each path segment for sqlite3's URI parser (a space, `?`,
// `#` or `%` in a name); the `/` separators stay literal. sqlite3 decodes the
// whole URI before use.
function encodeSqliteUriPath(p) {
  return p.split('/').map(encodeURIComponent).join('/');
}

function buildImmutableUri(p) {
  return `file:${encodeSqliteUriPath(p)}?immutable=1`;
}

// A zero-length -wal is not a real journal; it reads the same as no -wal.
function walIsPresent(origPath) {
  try { return fs.statSync(`${origPath}-wal`).size > 0; }
  catch { return false; }
}

// No journal: the original file is opened in place through `immutable=1`, so
// sqlite3 skips locking and creates no -shm/-wal siblings. With a real -wal
// this is not used: immutable reads past an uncheckpointed journal (a schema
// that lives in the -wal comes back empty, with "no such table"). Then the
// main file and its -wal are copied into a fresh directory for this call and
// opened there; the directory is removed afterwards. -shm is not copied: it is
// a regenerable index, not data.
function prepareOpen(origPath) {
  if (!walIsPresent(origPath)) {
    return { openPath: buildImmutableUri(origPath), cleanup: () => {}, viaCopy: false, copyMs: null };
  }
  const t0 = Date.now();
  let tmpDir;
  try {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vmcp-sqlite-copy-'));
    const dstDb = path.join(tmpDir, path.basename(origPath));
    fs.copyFileSync(origPath, dstDb);
    fs.copyFileSync(`${origPath}-wal`, `${dstDb}-wal`);
    return {
      openPath: dstDb,
      cleanup: () => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} },
      viaCopy: true,
      copyMs: Date.now() - t0,
    };
  } catch (e) {
    if (tmpDir) try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    // The copy step failed: no space, unreadable source, or an unwritable temp
    // directory. No test triggers this branch.
    throw new Error(`WAL_PRESENT_READONLY: could not prepare a working copy of ${origPath} alongside its -wal journal — ${e.message}`);
  }
}

// Low-level spawn: execFile, no shell, SQL is one argv element. stdin is
// closed. cwd is a fresh temp dir per call, removed afterwards.
function spawnSqlite3(args, { timeoutMs, maxBuffer } = {}) {
  return new Promise((resolve, reject) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vmcp-sqlite-'));
    const cleanup = () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} };
    let timedOut = false, timer = null, child;
    try {
      child = execFile(SQLITE_BIN, args, {
        cwd: tmp, maxBuffer: maxBuffer || MAX_STDOUT_BYTES, windowsHide: true,
      }, (err, stdout, stderr) => {
        if (timer) clearTimeout(timer);
        cleanup();
        if (!err) return resolve({ stdout, stderr });
        reject(Object.assign(err, { timedOut, stderrSoFar: stderr, stdoutSoFar: stdout }));
      });
    } catch (e) {
      cleanup();
      reject(e);
      return;
    }
    try { child.stdin.end(); } catch {}
    if (timeoutMs) {
      timer = setTimeout(() => { timedOut = true; try { child.kill('SIGKILL'); } catch {} }, timeoutMs);
    }
  });
}

function mapSpawnError(err, timeoutMs) {
  if (err.code === 'ENOENT') return new Error('SQLITE_MISSING: sqlite3 binary not found on PATH');
  if (err.timedOut) return new Error(`QUERY_TIMEOUT: query killed after ${timeoutMs} ms`);
  if (err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' || /maxBuffer/i.test(err.message || ''))
    return new Error(`OUTPUT_TOO_LARGE: sqlite3 output exceeded ${MAX_STDOUT_BYTES} bytes — narrow the column list or lower limit. No partial result is returned.`);
  const msg = (err.stderrSoFar || err.message || '').toString().trim();
  // hard_heap_limit tripped: the query's working memory (a large sort,
  // group_concat() over many rows, hex() on a large BLOB), not its output
  // (OUTPUT_TOO_LARGE) or its run time (QUERY_TIMEOUT).
  if (/out of memory/i.test(msg))
    return new Error(`QUERY_TOO_LARGE: the query exceeded its working-memory limit (${HARD_HEAP_LIMIT_BYTES} bytes, fixed) and was stopped — something in it allocates a lot in one place (a large sort, group_concat() over many rows, hex()/similar on a large BLOB). Narrow the query or reduce what it aggregates.`);
  // dbPath is either opened `immutable=1` or is a copy in a writable temp
  // directory (prepareOpen()), so a read-only-directory failure falls through
  // to SQLITE_ERROR. WAL_PRESENT_READONLY is raised by prepareOpen() when the
  // copy fails.
  return new Error(`SQLITE_ERROR: ${msg}`);
}

function parseJsonRows(stdout) {
  const trimmed = (stdout || '').trim();
  if (!trimmed) return []; // sqlite3 -json prints nothing for zero rows
  let rows;
  try { rows = JSON.parse(trimmed); }
  catch { throw new Error(`MALFORMED_OUTPUT: sqlite3 -json output did not parse as JSON — first 200 bytes: ${trimmed.slice(0, 200)}`); }
  if (!Array.isArray(rows)) throw new Error(`MALFORMED_OUTPUT: sqlite3 -json output was not a JSON array — first 200 bytes: ${trimmed.slice(0, 200)}`);
  return rows;
}

// PRAGMA hard_heap_limit=N prints its own result ahead of the query's output,
// on the same stdout, with no separator (-safe refuses .output, so it cannot
// be suppressed). The echo shows on every call that this sqlite3 accepted the
// limit; an unknown PRAGMA name would do nothing, silently. It comes back as
// JSON or as the bare number, so the value is checked, not one form.
const HEAP_LIMIT_ECHO_CANDIDATES = [
  `[{"hard_heap_limit":${HARD_HEAP_LIMIT_BYTES}}]`, // -json mode
  `${HARD_HEAP_LIMIT_BYTES}`,                        // default (list) mode
];

// Streaming-safe prefix check across every known form at once: {done:false}
// while stdout-so-far could still turn into ANY candidate, {done:true, ok,
// len} once it has either matched one completely or ruled out all of them.
function evalHeapLimitEcho(buf) {
  let stillPossible = false;
  for (const cand of HEAP_LIMIT_ECHO_CANDIDATES) {
    if (buf.length >= cand.length) {
      if (buf.startsWith(cand)) return { done: true, ok: true, len: cand.length };
    } else if (cand.startsWith(buf)) {
      stillPossible = true;
    }
  }
  return stillPossible ? { done: false } : { done: true, ok: false };
}

function heapLimitUnconfirmedError(gotSoFar) {
  const err = new Error(`HEAP_LIMIT_UNCONFIRMED: this sqlite3 build did not confirm hard_heap_limit=${HARD_HEAP_LIMIT_BYTES} — refusing to run the query rather than risk unbounded memory use. Expected the pragma echo to start with one of: ${HEAP_LIMIT_ECHO_CANDIDATES.join(' | ')}. Got: ${JSON.stringify(gotSoFar.slice(0, 200))}`);
  err.heapLimitUnconfirmed = true;
  return err;
}

// stdout is read as it streams: the echo is the first thing sqlite3 writes,
// and the process is killed as soon as it diverges from every known form,
// before the query has a chance to grow. A check after exit would come only
// once an unlimited query had already run. That is why runSqlite() does not
// use spawnSqlite3() (execFile returns stdout after exit); sqliteVersion()
// does.
function runSqliteChecked(openPath, sql, timeoutMs) {
  return new Promise((resolve, reject) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vmcp-sqlite-'));
    const cleanup = () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} };
    // openPath is what prepareOpen() decided: a `file:...?immutable=1` URI or
    // the path of the private copy. sqlite3 parses the URI form without a
    // `-uri` flag, which Alpine's sqlite3 does not have.
    // `.explain off`: otherwise the CLI draws EXPLAIN and EXPLAIN QUERY PLAN
    // output as a text table and ignores -json. It stays after the pragma,
    // whose echo must be the first bytes on stdout; it prints nothing itself.
    const args = ['-cmd', `PRAGMA hard_heap_limit=${HARD_HEAP_LIMIT_BYTES};`, '-cmd', '.explain off', '-readonly', '-safe', '-json', openPath, sql];

    let child;
    try {
      child = spawn(SQLITE_BIN, args, { cwd: tmp, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      cleanup();
      reject(e);
      return;
    }
    try { child.stdin.end(); } catch {}

    let stdout = '', stderr = '', stdoutBytes = 0;
    let settled = false, timedOut = false;
    // 'pending': stdout-so-far is still a valid prefix of at least one known
    // echo form. 'confirmed': one matched fully — stop checking, let the rest
    // of the stream through untouched. Any divergence from every known form
    // rejects immediately. echoMatchedLen is set once confirmed.
    let echoState = 'pending', echoMatchedLen = 0;

    const timer = timeoutMs ? setTimeout(() => { timedOut = true; finish(reject, Object.assign(new Error('timed out'), { timedOut: true })); }, timeoutMs) : null;

    function finish(fn, arg) {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try { child.kill('SIGKILL'); } catch {}
      cleanup();
      fn(arg);
    }

    child.stdout.on('data', chunk => {
      if (settled) return;
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_STDOUT_BYTES) {
        finish(reject, Object.assign(new Error('stdout maxBuffer exceeded'), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }));
        return;
      }
      stdout += chunk.toString('utf8');
      if (echoState === 'pending') {
        const r = evalHeapLimitEcho(stdout);
        if (r.done) {
          if (!r.ok) { finish(reject, heapLimitUnconfirmedError(stdout)); return; }
          echoState = 'confirmed';
          echoMatchedLen = r.len;
        }
      }
    });
    child.stderr.on('data', chunk => { stderr += chunk.toString('utf8'); });
    child.on('error', err => finish(reject, err));
    child.on('close', code => {
      if (settled) return;
      if (echoState !== 'confirmed') { finish(reject, heapLimitUnconfirmedError(stdout)); return; }
      const body = stdout.slice(echoMatchedLen);
      if (code !== 0) {
        finish(reject, Object.assign(new Error(stderr || `sqlite3 exited with code ${code}`), { stderrSoFar: stderr, stdoutSoFar: body }));
        return;
      }
      finish(resolve, { stdout: body, stderr });
    });
  });
}

async function runSqlite(openPath, sql, timeoutMs) {
  // Every query goes through here, so all of them get the same limit and the
  // same echo check. openPath is prepareOpen()'s result for this call.
  let res;
  try { res = await runSqliteChecked(openPath, sql, timeoutMs); }
  catch (err) {
    if (err.heapLimitUnconfirmed) throw err; // already a finished HEAP_LIMIT_UNCONFIRMED Error
    throw mapSpawnError(err, timeoutMs);
  }
  return parseJsonRows(res.stdout);
}

let cachedVersion = null;
async function sqliteVersion() {
  if (cachedVersion) return cachedVersion;
  let res;
  try { res = await spawnSqlite3(['-version']); }
  catch (err) { throw mapSpawnError(err, 0); }
  cachedVersion = res.stdout.trim().split(/\s+/)[0] || res.stdout.trim();
  return cachedVersion;
}

// ---------------------------------------------------------------------------
// sqlite_schema
// ---------------------------------------------------------------------------

async function schema(brandedPath, opts) {
  // One unwrap at the entry point; everything below works on the string.
  const p = SP.pathOf(brandedPath, 'sqlite_schema');
  opts = opts || {};
  assertKnownOptions(opts, SCHEMA_OPTION_KEYS, 'sqlite_schema');
  const wantCounts = opts.counts === true || opts.counts === 'true';
  const countsTimeoutMs = clampInt(opts.counts_timeout_ms, DEFAULT_COUNTS_TIMEOUT_MS, 1, MAX_COUNTS_TIMEOUT_MS, 'counts_timeout_ms');

  const t0 = Date.now();
  const st = assertRegularFile(p);
  checkSqliteHeader(p);

  // One open decision for the whole call, not one per spawn (counts:true
  // spawns sqlite3 once per table). See prepareOpen().
  const { openPath, cleanup, viaCopy, copyMs } = prepareOpen(p);
  try {
    const version = await sqliteVersion();
    const objects = await runSqlite(openPath, SQLITE_MASTER_QUERY);
    const pragmaRows = await runSqlite(openPath, PRAGMA_QUERY);
    const pragmas = pragmaRows[0] || { journal_mode: null, page_size: null, page_count: null, encoding: null, user_version: null, application_id: null };

    let counts = null, incompleteTables = null;
    if (wantCounts) {
      counts = {};
      const tableNames = objects.filter(o => o.type === 'table').map(o => o.name);
      for (const name of tableNames) {
        // Each table gets its own counts_timeout_ms window, covering the whole
        // per-table call (spawn, open, COUNT(*)). counts stays number|null;
        // tables that timed out are listed once in incompleteTables.
        try {
          const rows = await runSqlite(openPath, `SELECT COUNT(*) AS n FROM ${quoteIdent(name)}`, countsTimeoutMs);
          counts[name] = rows.length ? Object.values(rows[0])[0] : null;
        } catch (e) {
          if (/^QUERY_TIMEOUT:/.test(e.message)) {
            counts[name] = null;
            (incompleteTables = incompleteTables || []).push(name);
          } else {
            throw e;
          }
        }
      }
    }
    const countsIncomplete = incompleteTables && {
      tables: incompleteTables,
      note: `COUNT(*) did not finish within counts_timeout_ms=${countsTimeoutMs} — raise it, or count one table via sqlite_query`,
    };

    return {
      path: p,
      size: st.size,
      mtime_utc: st.mtime.toISOString(),
      mtime_local: toLocalOffsetString(st.mtime),
      sqlite3_version: version,
      pragmas,
      objects,
      wal_present: fs.existsSync(`${p}-wal`),
      shm_present: fs.existsSync(`${p}-shm`),
      wal_copy: viaCopy,
      wal_copy_ms: copyMs,
      counts,
      counts_incomplete: countsIncomplete,
      elapsed_ms: Date.now() - t0,
    };
  } finally {
    cleanup();
  }
}

// ---------------------------------------------------------------------------
// sqlite_query
// ---------------------------------------------------------------------------

function firstKeyword(s) {
  const m = /^([A-Za-z]+)/.exec(s);
  return m ? m[1].toUpperCase() : '';
}

// EXPLAIN and EXPLAIN QUERY PLAN are modifiers, not statements: what follows
// has to be a statement in its own right. Only whitespace may follow the
// keyword: a comment there (EXPLAIN/**/SELECT 1) is refused.
const EXPLAIN_PREFIX_RE = /^EXPLAIN(\s+QUERY\s+PLAN)?\s+/i;
const EXPLAINABLE_KEYWORDS = STATEMENT_KEYWORDS.filter(k => k !== 'EXPLAIN');

// Tokenizer, not a parser: it walks the statement once and records what it
// finds, so that a ";" inside a string literal, a quoted identifier or a
// comment is left alone while a ";" that really does end a statement is
// caught.
//
// The rules below are taken from SQLite's own src/tokenize.c
// (sqlite3GetToken, tag version-3.49.2). Where this disagrees with SQLite it
// only refuses more, never less: `/*` at the very end of the input is
// SQLite's division operator and an unterminated comment here.
//
// Bind parameters are refused, not modelled. SQLite reads $name(...) as one
// token, quote characters inside the brackets included, so in
// `SELECT 1 AS x WHERE $a(') ) ; SELECT 2 AS y /*')` a scanner of strings,
// comments and parentheses would miss the second statement. sqlite_query has
// nothing to bind anyway.
//
// Pure: it reads the string and returns what it found. The caller decides
// which finding to raise.
const PARAMETER_CHARS = new Set(['$', '@', ':', '#', '?']);

function scanSql(sql) {
  const findings = [];
  const seen = new Set();
  // One finding per code, the earliest — several ";" are one answer, not five.
  const add = (code, message) => { if (!seen.has(code)) { seen.add(code); findings.push({ code, message }); } };

  // NUL is checked over the whole input, literals and comments included: it
  // ends SQLite's token stream wherever it sits, so it is never just data.
  const nul = sql.indexOf('\0');
  if (nul !== -1) add('MALFORMED_SQL', `MALFORMED_SQL: NUL character at character ${nul}`);

  const openParens = [];
  const n = sql.length;
  let i = 0;
  while (i < n) {
    const c = sql[i];

    // Quoted: '…' string, "…" and `…` identifiers. A doubled delimiter is an
    // escape and the literal continues; a single one closes it.
    if (c === "'" || c === '"' || c === '`') {
      const what = c === "'" ? 'string literal' : 'quoted identifier';
      let j = i + 1;
      for (;;) {
        if (j >= n) { add('MALFORMED_SQL', `MALFORMED_SQL: unterminated ${what} starting at character ${i}`); i = n; break; }
        if (sql[j] === c) {
          if (sql[j + 1] === c) { j += 2; continue; }
          i = j + 1; break;
        }
        j++;
      }
      continue;
    }

    // [identifier] — closed by the first "]", no escaping inside.
    if (c === '[') {
      const end = sql.indexOf(']', i + 1);
      if (end === -1) { add('MALFORMED_SQL', `MALFORMED_SQL: unterminated [identifier] starting at character ${i}`); i = n; }
      else i = end + 1;
      continue;
    }

    // -- to the end of the line. Only "\n" ends it, not "\r". Running to the
    // end of the input is fine: the wrapper puts a newline after the query.
    if (c === '-' && sql[i + 1] === '-') {
      const nl = sql.indexOf('\n', i + 2);
      i = nl === -1 ? n : nl + 1;
      continue;
    }

    // /* … */ — the search for the terminator starts past both opening
    // characters, so /**/ is closed and /*/ is not.
    if (c === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2);
      if (end === -1) { add('MALFORMED_SQL', `MALFORMED_SQL: unterminated /* comment starting at character ${i}`); i = n; }
      else i = end + 2;
      continue;
    }

    if (PARAMETER_CHARS.has(c)) {
      add('PARAMETERS_NOT_SUPPORTED', `PARAMETERS_NOT_SUPPORTED: bind parameter "${c}" at character ${i} — sqlite_query has nothing to bind it to; write the value into the SQL as a literal`);
      i++;
      continue;
    }

    if (c === '(') { openParens.push(i); i++; continue; }

    if (c === ')') {
      if (openParens.length) openParens.pop();
      else add('MALFORMED_SQL', `MALFORMED_SQL: ")" at character ${i} has no matching "("`);
      i++;
      continue;
    }

    if (c === ';') {
      add('MULTIPLE_STATEMENTS', `MULTIPLE_STATEMENTS: only one statement is accepted — ";" at character ${i} ends a statement. A ";" inside a string literal, a quoted identifier or a comment is fine.`);
      i++;
      continue;
    }

    // Everything else is an ordinary character, backslash included — SQLite
    // has no backslash escape. That covers the x of a blob literal too: the
    // "'" after it opens a string here, and SQLite closes the blob on the same
    // "'" that closes the string here.
    i++;
  }

  if (openParens.length)
    add('MALFORMED_SQL', `MALFORMED_SQL: "(" at character ${openParens[0]} is never closed`);

  return findings;
}

// Raised by priority, not by position: an unbalanced parenthesis and a ";" in
// the same statement are reported as malformed.
const SCAN_PRIORITY = ['MALFORMED_SQL', 'PARAMETERS_NOT_SUPPORTED', 'MULTIPLE_STATEMENTS'];

// Checks run in this order, each with its own error code. Together with
// -readonly and -safe they are the protection against a second statement:
// nothing downstream would catch one.
//
// Returns the statement split into the part that must stay OUTSIDE the wrapper
// and the part that goes inside it. `prefix` is empty for everything except
// EXPLAIN: SELECT * FROM (EXPLAIN …) is not a query SQLite will parse, so the
// modifier is lifted out and the wrapper closes around the statement it
// modifies instead.
function validateSql(rawSql) {
  if (typeof rawSql !== 'string') throw new Error('sql must be a string');
  let sql = rawSql.trim();
  if (sql.endsWith(';')) sql = sql.slice(0, -1).trimEnd();
  if (!sql) throw new Error('sql must not be empty');
  if (sql.startsWith('.')) {
    const word = sql.split(/\s/)[0];
    throw new Error(`DOT_COMMAND: dot-commands are not accepted ("${word}") — -safe does not filter all of them out of argv, so they are refused here first.`);
  }
  const findings = scanSql(sql);
  for (const code of SCAN_PRIORITY) {
    const f = findings.find(x => x.code === code);
    if (f) throw new Error(f.message);
  }
  const kw = firstKeyword(sql);
  if (!STATEMENT_KEYWORDS.includes(kw))
    throw new Error(`INVALID_STATEMENT: statement must start with ${STATEMENT_KEYWORDS.join(', ')} — got "${sql.slice(0, 30)}"`);

  if (kw !== 'EXPLAIN') return { prefix: '', sql };

  const m = EXPLAIN_PREFIX_RE.exec(sql);
  if (!m)
    throw new Error(`INVALID_STATEMENT: EXPLAIN and EXPLAIN QUERY PLAN must be followed by whitespace and the statement to explain — got "${sql.slice(0, 30)}"`);
  const body = sql.slice(m[0].length);
  if (!EXPLAINABLE_KEYWORDS.includes(firstKeyword(body)))
    throw new Error(`INVALID_STATEMENT: what follows EXPLAIN must start with ${EXPLAINABLE_KEYWORDS.join(', ')} — got "${body.slice(0, 30)}"`);
  return { prefix: m[0], sql: body };
}

async function query(brandedPath, rawSql, opts) {
  const p = SP.pathOf(brandedPath, 'sqlite_query');
  opts = opts || {};
  assertKnownOptions(opts, QUERY_OPTION_KEYS, 'sqlite_query');
  const limit = clampInt(opts.limit, DEFAULT_LIMIT, 1, MAX_LIMIT, 'limit');
  const timeoutMs = clampInt(opts.timeout_ms, DEFAULT_TIMEOUT_MS, 1, MAX_TIMEOUT_MS, 'timeout_ms');

  const st = assertRegularFile(p);
  checkSqliteHeader(p);
  const { prefix, sql } = validateSql(rawSql);

  // The wrapper rejects anything that is not row-producing and detects
  // truncation (limit+1 rows asked, the extra one dropped). It does not
  // guarantee a single statement; scanSql() does.
  //
  // The newlines around the query end a trailing "--" comment before the
  // wrapper's ") LIMIT n".
  //
  // An EXPLAIN prefix sits in front of the whole wrapper, never inside it, so
  // what gets explained is the wrapped statement. Two consequences, both in
  // the tool description: the plan shows the wrapper's own rows, and LIMIT
  // does not reach the opcode listing at all — sqlite returns every row and
  // the clipping below is what shortens it.
  const wrapped = `${prefix}SELECT * FROM (\n${sql}\n) LIMIT ${limit + 1}`;

  const { openPath, cleanup, viaCopy, copyMs } = prepareOpen(p);
  let rows, elapsedMs;
  try {
    const t0 = Date.now();
    rows = await runSqlite(openPath, wrapped, timeoutMs);
    elapsedMs = Date.now() - t0;
  } finally {
    cleanup();
  }

  const truncated = rows.length > limit;
  const clipped = truncated ? rows.slice(0, limit) : rows;

  return {
    path: p,
    size: st.size,
    mtime_utc: st.mtime.toISOString(),
    mtime_local: toLocalOffsetString(st.mtime),
    wal_copy: viaCopy,
    wal_copy_ms: copyMs,
    columns: clipped.length ? Object.keys(clipped[0]) : [],
    rows: clipped,
    row_count: clipped.length,
    truncated,
    elapsed_ms: elapsedMs,
  };
}

module.exports = { schema, query, validateSql };
