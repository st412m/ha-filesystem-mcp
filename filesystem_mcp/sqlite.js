'use strict';
/**
 * Vault MCP — read-only SQLite inspection (2.7.0, WAL side-file fix in 2.7.2)
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
 * tokenizes the statement before sqlite3 is ever started.
 *
 * The `SELECT * FROM (<sql>) LIMIT <n>` wrapper is NOT one of them, and until
 * 2.8.0 the comments here said otherwise. A wrapper can be closed from the
 * inside: `SELECT 1 AS x) ; SELECT 2 AS y /*` ends up as two statements, the
 * `)` closing the wrapper's parenthesis and the unterminated `/*` swallowing
 * the `) LIMIT n` that should have followed — measured, both statements ran.
 * The wrapper gives a row limit, truncation detection and a row-producing
 * shape, and it can only do that because the scanner has already guaranteed
 * balanced parentheses, closed comments and no second statement.
 *
 * 2.7.2 adds a fourth concern, orthogonal to the three above: how the file
 * gets opened at all. A plain `-readonly` open of a WAL-mode database still
 * creates a `-shm` and (if missing) a `-wal` sibling next to it — harmless on
 * its own, but the add-on's main use case is a vault synced by Syncthing,
 * where every read then propagates two new files to every other device. See
 * prepareOpen() below for the fix (immutable URI or a private copy) and
 * sqlite-spec-272.md §1 for the measurement behind it.
 *
 * schema()/query() still perform no containment check of their own — this
 * module has no idea where the vault root is, and neither it nor policy.js
 * duplicates resolveSafe's escape-hardening, which took two rounds to get
 * right (see the 2.5.0 symlink/sibling-prefix note in safepath.js). What
 * changed in 2.8.0 is that the contract is now checked instead of assumed:
 * `p` must be a path produced by safepath.js, and pathOf() refuses anything
 * else with UNVERIFIED_PATH before a single byte is read. Until 2.7.3 this
 * was a comment, and 2.7.1's acceptance walked straight past it — calling
 * query()/schema() directly with a string, bypassing server.js, read a file
 * outside the vault. That call now throws.
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

// A LIMIT wrapped around the outer statement does not bound an unbounded
// recursive CTE sitting under an aggregate — SELECT max(n) FROM (WITH
// RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM c) SELECT n FROM c)
// must fully materialize the (infinite) input before max() can produce a row,
// so the LIMIT in query()'s wrapper never gets a chance to matter. Without a
// second, independent stop that failure mode grows in memory until timeout_ms
// (up to 30s) or the OOM killer takes the whole add-on process with it —
// every file tool included, not just this query. Confirmed against the real
// Alpine sqlite3 in the add-on image (3.49.2, by hand, not from this
// machine): PRAGMA hard_heap_limit sets from the default off (0) and turns
// that query into "out of memory" instead of unbounded growth. This machine's
// own sqlite3 (Windows, 3.44.4) is not evidence either way for anything
// involving -safe's exact restricted-command list or heap enforcement — it
// has already been wrong once (see runSqlite()'s comment on the pragma's
// echo) — so nothing here is asserted as verified unless it was actually run
// against the real Alpine binary.
// 256 MiB, hardcoded and not exposed as a tool parameter: raising it changes
// what "unbounded" means for every query and every table's COUNT(*), not just
// the one call that asked for it.
const HARD_HEAP_LIMIT_BYTES = 268435456;

const STATEMENT_KEYWORDS = ['SELECT', 'WITH', 'VALUES', 'EXPLAIN'];

// Tool option keys, snake_case, identical to the inputSchema property names in
// server.js — no camelCase alter ego anywhere in this module. The previous
// version accepted opts.countsTimeoutMs internally while server.js and the
// tool schema both said counts_timeout_ms: server.js's translation from one
// name to the other was correct, but a translation step is exactly the kind
// of place a typo hides for three rounds without ever failing loudly. Options
// are now read under their tool-schema names directly, and an unrecognized
// key is a hard error instead of a silent no-op — see assertKnownOptions().
const SCHEMA_OPTION_KEYS = ['counts', 'counts_timeout_ms'];
const QUERY_OPTION_KEYS = ['limit', 'timeout_ms'];

function assertKnownOptions(opts, allowed, toolName) {
  const unknown = Object.keys(opts).filter(k => !allowed.includes(k));
  if (unknown.length)
    throw new Error(`unknown option(s) for ${toolName}: ${unknown.join(', ')} — accepted: ${allowed.join(', ')}`);
}

// One row, six columns, two spawns total for sqlite_schema instead of seven —
// every pragma here takes zero or one argument, which SQLite has exposed as a
// table-valued function since 3.16.0. Verified against the actual sqlite3
// binary before relying on it: a plain cross join of six single-row functions
// returns one row with all six columns correctly named.
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

// This add-on is public and its vault is not always read from the same
// machine or timezone — a hardcoded MSK offset (2.7.0/2.7.1's mtime_msk) is
// wrong for anyone else and was removed in 2.7.2 (breaking response-format change, see
// CHANGELOG.md). This reads the container's own local time via plain Date
// getters (respecting its TZ, whatever that is) and appends the numeric
// offset instead of a fixed abbreviation — no Intl/tz-data dependency.
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

// null unless every byte is printable ASCII — a hex dump of genuine binary
// garbage (an encrypted SQLCipher header, random bytes) gains nothing from an
// ASCII rendering, so it is only added when it would actually read as text.
function asciiIfPrintable(buf) {
  let s = '';
  for (const b of buf) {
    if (b < 0x20 || b > 0x7e) return null;
    s += String.fromCharCode(b);
  }
  return s;
}

// Type is decided by the first 16 bytes only, never the extension — Bluecoins
// backups do not end in .db, and guessing from a suffix is a guaranteed bug
// report waiting to happen.
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
// a private copy of it plus its `-wal`. Decided ONCE per tool call (by
// schema()/query(), not by runSqlite()) — sqlite_schema with counts:true
// spawns sqlite3 once per table, and copying inside that per-spawn helper
// would make one call to a database with a dozen tables copy a
// possibly-hundreds-of-MB file a dozen times over.
// ---------------------------------------------------------------------------

// Percent-encodes one path segment at a time so sqlite3's URI parser doesn't
// choke on a space, `?`, `#` or `%` in the file name, while the `/`
// separators between segments stay literal. Encoding a character that didn't
// need it is harmless — sqlite3 percent-decodes the whole thing before use.
function encodeSqliteUriPath(p) {
  return p.split('/').map(encodeURIComponent).join('/');
}

function buildImmutableUri(p) {
  return `file:${encodeSqliteUriPath(p)}?immutable=1`;
}

// A zero-length -wal is this module's own past artifact (or some other
// reader's), not a real journal — treating it as "journal present" would
// permanently exile that database to the copy path over nothing forever
// after. No sibling at all reads the same way: no journal either way.
function walIsPresent(origPath) {
  try { return fs.statSync(`${origPath}-wal`).size > 0; }
  catch { return false; }
}

// No journal → open the ORIGINAL file in place through `immutable=1`: sqlite3
// skips locking and the -shm/-wal dance entirely, so a database living in a
// synced folder gains no sibling files from being read (measured on the real
// Alpine binary — sqlite-spec-272.md §1). This is deliberately not used when
// a real -wal sits next to the file: immutable tells sqlite3 the file will
// not change and nothing needs replaying, so it reads past an uncheckpointed
// journal's content rather than through it — on a database whose schema
// lives entirely in the -wal this comes back as an empty schema and "no such
// table", not a warning (confirmed against wal_hotcopy.db; see the matching
// regression test in the test matrix). So when a journal is present, the
// main file and its -wal are copied together into a fresh directory made for
// this call and opened from there instead — new -shm/-wal siblings are only
// ever allowed to appear in that throwaway copy, which is removed whole
// afterwards. -shm is not copied: it is a regenerable lock/index structure,
// not data, and the copy's directory is always writable.
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
    // Not a checkpoint problem (the copy destination is our own temp dir,
    // always writable) — this is our own copy step failing: no space left,
    // source unreadable, temp dir not writable. Kept as WAL_PRESENT_READONLY
    // for the error code's continuity, but the text is now about the copy,
    // not about checkpointing — see sqlite-spec-272.md §3. Known-uncovered
    // synthetically, same as before: nothing in test/ makes mkdtempSync or
    // copyFileSync fail on purpose.
    throw new Error(`WAL_PRESENT_READONLY: could not prepare a working copy of ${origPath} alongside its -wal journal — ${e.message}`);
  }
}

// Low-level spawn, shared by every call into sqlite3. execFile — no shell,
// argv array, SQL is one argv element. stdin is explicitly closed: sqlite3
// does not read it when SQL is given as an argument, but nothing here should
// depend on that. cwd is a fresh temp dir per call, removed afterwards.
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
  // hard_heap_limit tripped: the query's working memory, not its output, is
  // the problem — a large sort, group_concat() over many rows, hex()/similar
  // on a large BLOB: something that allocates a lot in one place. Distinct
  // from OUTPUT_TOO_LARGE (a large RESULT reaching stdout) and QUERY_TIMEOUT
  // (ran too long, whatever the memory use — an unbounded recursive CTE
  // under an aggregate is CPU-bound, not memory-bound: measured at sys 0.05s
  // over a full 20s run on the real Alpine binary, so timeout_ms is its
  // correct stop, not this one — see sqlite-spec.md).
  if (/out of memory/i.test(msg))
    return new Error(`QUERY_TOO_LARGE: the query exceeded its working-memory limit (${HARD_HEAP_LIMIT_BYTES} bytes, fixed) and was stopped — something in it allocates a lot in one place (a large sort, group_concat() over many rows, hex()/similar on a large BLOB). Narrow the query or reduce what it aggregates.`);
  // WAL_PRESENT_READONLY no longer comes from here (matching sqlite3's own
  // "attempt to write a readonly database" / "unable to open database file"
  // text against a -wal sibling, as in 2.7.1). Since 2.7.2 dbPath is always
  // either opened `immutable=1` (no journal, nothing to write) or is already
  // a copy of the original sitting in our own always-writable temp dir (a
  // real journal was present) — see prepareOpen(). That open failing for a
  // read-only-directory reason should no longer happen; if it does, it falls
  // through to the generic SQLITE_ERROR below rather than a wrong-sounding
  // dedicated one. The dedicated code is now raised directly by prepareOpen()
  // when the copy step itself fails.
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

// PRAGMA hard_heap_limit=N is itself a query: it prints its own result ahead
// of the trailing SQL argument's own output, on the same stdout, back to
// back, no separator between them. (First tried suppressing it with .output
// around just that statement; -safe rejects .output outright — "cannot run
// .output in safe mode" — confirmed against the real Alpine binary, not this
// machine's.) Rather than fight the echo, it is put to use: this is the one
// place we can see, on every single call, that this build's sqlite3 actually
// accepted the limit — a PRAGMA name SQLite does not recognize is normally a
// silent no-op.
//
// What that echo looks like is not pinned to one exact string: a build-time
// smoke test in toolchain-check.sh, running what reads like the identical
// command line, once got back a bare 268435456 where this got back
// [{"hard_heap_limit":268435456}] — same value, different serialization, for
// a reason neither of us could pin down from source alone (not a flag-order
// difference: the two argv sequences compared byte-for-byte identical). What
// is not in doubt is the VALUE, so that is what gets checked — either known
// form confirms the limit is live, and pinning the check to one exact string
// was the actual bug, not a symptom of a different one.
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

// Checking the echo only after the process exits (as an earlier version of
// this function did, via spawnSqlite3/execFile) means an unbounded query on a
// build where the limit silently did not take hold gets to run to completion
// — or to timeout_ms, or to the OS OOM-killer — before the check ever runs.
// That is exactly the case this whole mechanism exists to catch: the
// protection would arrive after the damage, not instead of it. So this reads
// stdout as it streams in instead of buffering it: the echo is the first
// thing sqlite3 ever writes, checked against the exact expected bytes as soon
// as enough of them have arrived (or killed the moment they diverge, without
// waiting for a full line) — before the trailing SQL argument's query has any
// real chance to grow. This is why runSqlite() cannot share spawnSqlite3()
// (execFile only hands back stdout once the process has already exited);
// sqliteVersion() has no query to protect against and keeps using it.
function runSqliteChecked(openPath, sql, timeoutMs) {
  return new Promise((resolve, reject) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vmcp-sqlite-'));
    const cleanup = () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} };
    // openPath is whatever prepareOpen() decided for this call: a `file:...
    // ?immutable=1` URI, or the path of our own copy — sqlite3 parses the URI
    // form on this build without needing a `-uri` flag (that flag does not
    // exist on Alpine's sqlite3 3.49.2 at all — confirmed, do not add it).
    // `.explain off` is load-bearing for EXPLAIN: the CLI switches itself into
    // a fixed-column text layout for EXPLAIN and EXPLAIN QUERY PLAN output and
    // ignores -json while it is on, so parseJsonRows() would see a drawn table
    // and raise MALFORMED_OUTPUT. Turning it off restores JSON (addr/opcode/p1…
    // and id/parent/notused/detail). It must stay AFTER the pragma: the echo
    // check below expects the pragma's own output to be the first bytes on
    // stdout, and `.explain off` prints nothing of its own.
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
  // Every caller goes through here, so sqlite_schema's DDL/PRAGMA queries and
  // every table's COUNT(*) get the same limit and the same streamed
  // confirmation that sqlite_query does. openPath is prepareOpen()'s result,
  // decided once per tool call — never the original path directly.
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

  // One open decision for the whole call — not one per spawn. counts:true
  // spawns sqlite3 once per table (thirteen times on the recorder database);
  // deciding immutable-vs-copy inside runSqlite() would copy the file that
  // many times over for one sqlite_schema call. See prepareOpen().
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
        // Each table gets its OWN full counts_timeout_ms window — one slow table
        // (a full scan on a large one) must not take the rest of the schema down
        // with it, and a fast table is not charged for a slow neighbour. The
        // window covers the whole per-table call (spawning sqlite3, opening the
        // database file, running COUNT(*)), not just the count itself, so on a
        // large database file a very small window can time out even a table
        // with a handful of rows — see DOCS.md. counts stays number|null
        // throughout; which tables timed out goes in incompleteTables as a
        // plain list, not a duplicated per-table message (a base with dozens of
        // tables would otherwise repeat the same sentence dozens of times).
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
// has to be a statement in its own right. Whitespace only after the keyword —
// a comment there (EXPLAIN/**/SELECT 1) does not match and is refused, which
// is the conservative side to be on.
const EXPLAIN_PREFIX_RE = /^EXPLAIN(\s+QUERY\s+PLAN)?\s+/i;
const EXPLAINABLE_KEYWORDS = STATEMENT_KEYWORDS.filter(k => k !== 'EXPLAIN');

// Tokenizer, not a parser: it walks the statement once and records what it
// finds, so that a ";" inside a string literal, a quoted identifier or a
// comment is left alone while a ";" that really does end a statement is
// caught. Until 2.8.0 this was sql.includes(';'), which refused the first and
// was the only thing standing between a crafted query and a second statement.
//
// The rules below are taken from SQLite's own src/tokenize.c
// (sqlite3GetToken, tag version-3.49.2). Where this disagrees with SQLite it
// may only disagree by refusing more, never less — `/*` at the very end of the
// input is SQLite's division operator and our unterminated comment, and that
// asymmetry is the acceptable direction.
//
// Bind parameters are refused outright rather than modelled. SQLite reads
// $name(...) as ONE token and consumes everything up to a ")" or whitespace
// inside those brackets, quote characters included, so a scanner that knows
// only strings, comments and parentheses is walked straight through by
// `SELECT 1 AS x WHERE $a(') ) ; SELECT 2 AS y /*')` — it sees $a( then a
// string then ), while sqlite3 runs the second statement. Modelling that
// syntax to keep a feature nothing here can use would be the wrong trade:
// sqlite_query has no parameters to bind in the first place.
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
    // "'" we close the string on.
    i++;
  }

  if (openParens.length)
    add('MALFORMED_SQL', `MALFORMED_SQL: "(" at character ${openParens[0]} is never closed`);

  return findings;
}

// Raised by priority, not by position: an unbalanced parenthesis and a ";"
// in the same statement mean the statement is malformed, and saying so is more
// use than pointing at the ";".
const SCAN_PRIORITY = ['MALFORMED_SQL', 'PARAMETERS_NOT_SUPPORTED', 'MULTIPLE_STATEMENTS'];

// Checks run in this exact order, each with its own error code — see
// sqlite-spec.md. Since 2.8.0 these checks ARE the protection against a second
// statement, alongside -readonly and -safe: nothing downstream would catch one.
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

  // The wrapper rejects anything that is not a row-producing expression and
  // gives a truncation signal for free — asking for limit+1 rows and dropping
  // the extra one if it came back. It does NOT guarantee a single statement;
  // scanSql() does, and the wrapper is only safe to build because of it. A
  // recursive CTE inside the subquery is parsed by SQLite normally.
  //
  // The newlines around the query are load-bearing. A perfectly legal "--"
  // comment at the end of the query would otherwise run on into the ") LIMIT n"
  // and swallow it; a newline ends the comment before the wrapper closes.
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

module.exports = { schema, query };
