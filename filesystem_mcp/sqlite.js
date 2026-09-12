'use strict';
/**
 * Vault MCP — read-only SQLite inspection (2.7.0)
 *
 * Two tools, schema-neutral: sqlite_schema() looks at what is in the file,
 * sqlite_query() runs exactly one read-only statement. Neither interprets the
 * data — no table or column name anywhere in this file is special-cased.
 *
 * All protection against writes and against escaping the vault through SQL
 * rests on three flags: `-readonly` (SQLITE_OPEN_READONLY), `-safe` (disables
 * ATTACH, .shell, .system, .open, writefile(), edit(), load_extension(),
 * fts3_tokenizer() — ATTACH matters most, since without it a query reads any
 * file on disk regardless of the vault's own zone check), and the
 * `SELECT * FROM (<sql>) LIMIT <n>` wrapper in query() (single statement,
 * read-only shape, truncation detection). Zone/path checks happen in
 * server.js via the existing resolveSafe() before either function here is
 * called — this module never sees a path outside the vault.
 *
 * Called the same way server.js calls pdftotext/pdftoppm for read_pdf_text/
 * read_pdf_page: execFile with an argv array (SQL is one argv element, never
 * shell-interpolated), no npm dependency.
 */

const { execFile, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

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

// His timezone is fixed MSK = UTC+3, no DST — no Intl/tz-data dependency.
function toMskString(d) {
  const msk = new Date(d.getTime() + 3 * 3600 * 1000);
  const p2 = n => String(n).padStart(2, '0');
  return `${msk.getUTCFullYear()}-${p2(msk.getUTCMonth() + 1)}-${p2(msk.getUTCDate())} ` +
         `${p2(msk.getUTCHours())}:${p2(msk.getUTCMinutes())}:${p2(msk.getUTCSeconds())} MSK`;
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

function mapSpawnError(err, dbPath, timeoutMs) {
  if (err.code === 'ENOENT') return new Error('SQLITE_MISSING: sqlite3 binary not found on PATH');
  if (err.timedOut) return new Error(`QUERY_TIMEOUT: query killed after ${timeoutMs} ms`);
  if (err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' || /maxBuffer/i.test(err.message || ''))
    return new Error(`OUTPUT_TOO_LARGE: sqlite3 output exceeded ${MAX_STDOUT_BYTES} bytes — narrow the column list or lower limit. No partial result is returned.`);
  const msg = (err.stderrSoFar || err.message || '').toString().trim();
  // hard_heap_limit tripped: the query's working memory, not its output, is
  // the problem — typically an unbounded recursive CTE or a cartesian product
  // sitting under an aggregate, which LIMIT cannot bound (see the constant's
  // comment above). Distinct from OUTPUT_TOO_LARGE (a large RESULT) and
  // QUERY_TIMEOUT (ran too long, however much memory it used).
  if (/out of memory/i.test(msg))
    return new Error(`QUERY_TOO_LARGE: the query exceeded its working-memory limit (${HARD_HEAP_LIMIT_BYTES} bytes, fixed) and was stopped — typically an unbounded recursive CTE or a cartesian product under an aggregate, which LIMIT cannot bound because the aggregate must consume all input first. Narrow the query.`);
  // A read-only connection needs to create the -shm wal-index itself when it
  // does not already exist, which needs write access on the DIRECTORY, not
  // the database file (sqlite.org/wal.html). This fails on a read-only
  // bind-mount, a share mounted without write permission, or a full volume —
  // sqlite3's own message there ("attempt to write a readonly database" /
  // "unable to open database file") reads like a bug in this server, not a
  // property of the mount, so it is recognized and replaced.
  // Known gap: not reproducible synthetically, and not under root (which
  // ignores Unix permission bits) — no fixture in test/ exercises this
  // branch; see test/make-fixtures.sh.
  if (/attempt to write a readonly database|unable to open database file/i.test(msg) && fs.existsSync(`${dbPath}-wal`)) {
    return new Error(`WAL_PRESENT_READONLY: ${dbPath} has not been checkpointed and a -wal journal sits next to it. Copy both the database file and its -wal (and -shm, if present) together, or checkpoint the source database first.`);
  }
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

// PRAGMA hard_heap_limit=N is itself a query: under -json it prints its own
// result — [{"hard_heap_limit":268435456}] — ahead of the trailing SQL
// argument's own JSON array, both on stdout, back to back, no separator
// between them. (First tried suppressing it with .output around just that
// statement; -safe rejects .output outright — "cannot run .output in safe
// mode" — confirmed against the real Alpine binary, not this machine's.)
// Rather than fight the echo, it is put to use: this is the one place we can
// see, on every single call, that this build's sqlite3 actually accepted the
// limit — a PRAGMA name SQLite does not recognize is normally a silent no-op.
const HEAP_LIMIT_ECHO = `[{"hard_heap_limit":${HARD_HEAP_LIMIT_BYTES}}]`;

function heapLimitUnconfirmedError(gotSoFar) {
  const err = new Error(`HEAP_LIMIT_UNCONFIRMED: this sqlite3 build did not confirm hard_heap_limit=${HARD_HEAP_LIMIT_BYTES} — refusing to run the query rather than risk unbounded memory use. Expected the echo ${HEAP_LIMIT_ECHO} first on stdout, got: ${JSON.stringify(gotSoFar.slice(0, 200))}`);
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
function runSqliteChecked(dbPath, sql, timeoutMs) {
  return new Promise((resolve, reject) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vmcp-sqlite-'));
    const cleanup = () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} };
    const args = ['-cmd', `PRAGMA hard_heap_limit=${HARD_HEAP_LIMIT_BYTES};`, '-readonly', '-safe', '-json', dbPath, sql];

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
    // 'pending': not enough bytes yet to know either way, but still a valid
    // prefix of the echo. 'confirmed': matched, stop checking, let the rest
    // of the stream through untouched. Any divergence rejects immediately.
    let echoState = 'pending';

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
        if (stdout.length >= HEAP_LIMIT_ECHO.length) {
          echoState = stdout.startsWith(HEAP_LIMIT_ECHO) ? 'confirmed' : 'failed';
        } else if (!HEAP_LIMIT_ECHO.startsWith(stdout)) {
          echoState = 'failed'; // already diverged, no need to wait for more bytes
        }
        if (echoState === 'failed') { finish(reject, heapLimitUnconfirmedError(stdout)); return; }
      }
    });
    child.stderr.on('data', chunk => { stderr += chunk.toString('utf8'); });
    child.on('error', err => finish(reject, err));
    child.on('close', code => {
      if (settled) return;
      if (echoState !== 'confirmed') { finish(reject, heapLimitUnconfirmedError(stdout)); return; }
      const body = stdout.slice(HEAP_LIMIT_ECHO.length);
      if (code !== 0) {
        finish(reject, Object.assign(new Error(stderr || `sqlite3 exited with code ${code}`), { stderrSoFar: stderr, stdoutSoFar: body }));
        return;
      }
      finish(resolve, { stdout: body, stderr });
    });
  });
}

async function runSqlite(dbPath, sql, timeoutMs) {
  // Every caller goes through here, so sqlite_schema's DDL/PRAGMA queries and
  // every table's COUNT(*) get the same limit and the same streamed
  // confirmation that sqlite_query does.
  let res;
  try { res = await runSqliteChecked(dbPath, sql, timeoutMs); }
  catch (err) {
    if (err.heapLimitUnconfirmed) throw err; // already a finished HEAP_LIMIT_UNCONFIRMED Error
    throw mapSpawnError(err, dbPath, timeoutMs);
  }
  return parseJsonRows(res.stdout);
}

let cachedVersion = null;
async function sqliteVersion() {
  if (cachedVersion) return cachedVersion;
  let res;
  try { res = await spawnSqlite3(['-version']); }
  catch (err) { throw mapSpawnError(err, '', 0); }
  cachedVersion = res.stdout.trim().split(/\s+/)[0] || res.stdout.trim();
  return cachedVersion;
}

// ---------------------------------------------------------------------------
// sqlite_schema
// ---------------------------------------------------------------------------

async function schema(p, opts) {
  opts = opts || {};
  assertKnownOptions(opts, SCHEMA_OPTION_KEYS, 'sqlite_schema');
  const wantCounts = opts.counts === true || opts.counts === 'true';
  const countsTimeoutMs = clampInt(opts.counts_timeout_ms, DEFAULT_COUNTS_TIMEOUT_MS, 1, MAX_COUNTS_TIMEOUT_MS, 'counts_timeout_ms');

  const t0 = Date.now();
  const st = assertRegularFile(p);
  checkSqliteHeader(p);

  const version = await sqliteVersion();
  const objects = await runSqlite(p, SQLITE_MASTER_QUERY);
  const pragmaRows = await runSqlite(p, PRAGMA_QUERY);
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
        const rows = await runSqlite(p, `SELECT COUNT(*) AS n FROM ${quoteIdent(name)}`, countsTimeoutMs);
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
    mtime_msk: toMskString(st.mtime),
    sqlite3_version: version,
    pragmas,
    objects,
    wal_present: fs.existsSync(`${p}-wal`),
    shm_present: fs.existsSync(`${p}-shm`),
    counts,
    counts_incomplete: countsIncomplete,
    elapsed_ms: Date.now() - t0,
  };
}

// ---------------------------------------------------------------------------
// sqlite_query
// ---------------------------------------------------------------------------

// Checks run in this exact order, each with its own error code — see
// sqlite-spec.md. This is not the protection mechanism (that is -readonly,
// -safe and the LIMIT wrapper below); it exists so a mistake gets a legible
// error instead of a raw SQLite syntax error.
function validateSql(rawSql) {
  if (typeof rawSql !== 'string') throw new Error('sql must be a string');
  let sql = rawSql.trim();
  if (sql.endsWith(';')) sql = sql.slice(0, -1).trimEnd();
  if (!sql) throw new Error('sql must not be empty');
  if (sql.startsWith('.')) {
    const word = sql.split(/\s/)[0];
    throw new Error(`DOT_COMMAND: dot-commands are not accepted ("${word}") — -safe does not filter all of them out of argv, so they are refused here first.`);
  }
  if (sql.includes(';'))
    throw new Error('MULTIPLE_STATEMENTS: only one statement is accepted. This also rejects a ";" that legitimately appears inside a string literal — split the query instead. See DOCS.md.');
  const m = /^([A-Za-z]+)/.exec(sql);
  const kw = m ? m[1].toUpperCase() : '';
  if (!STATEMENT_KEYWORDS.includes(kw))
    throw new Error(`INVALID_STATEMENT: statement must start with ${STATEMENT_KEYWORDS.join(', ')} — got "${sql.slice(0, 30)}"`);
  return sql;
}

async function query(p, rawSql, opts) {
  opts = opts || {};
  assertKnownOptions(opts, QUERY_OPTION_KEYS, 'sqlite_query');
  const limit = clampInt(opts.limit, DEFAULT_LIMIT, 1, MAX_LIMIT, 'limit');
  const timeoutMs = clampInt(opts.timeout_ms, DEFAULT_TIMEOUT_MS, 1, MAX_TIMEOUT_MS, 'timeout_ms');

  const st = assertRegularFile(p);
  checkSqliteHeader(p);
  const sql = validateSql(rawSql);

  // The wrapper does three things at once: guarantees a single statement,
  // rejects anything that is not a row-producing expression, and gives a
  // truncation signal for free — asking for limit+1 rows and dropping the
  // extra one if it came back. A recursive CTE inside the subquery is parsed
  // by SQLite normally.
  const wrapped = `SELECT * FROM (${sql}) LIMIT ${limit + 1}`;

  const t0 = Date.now();
  const rows = await runSqlite(p, wrapped, timeoutMs);
  const elapsedMs = Date.now() - t0;

  const truncated = rows.length > limit;
  const clipped = truncated ? rows.slice(0, limit) : rows;

  return {
    path: p,
    size: st.size,
    mtime_utc: st.mtime.toISOString(),
    mtime_msk: toMskString(st.mtime),
    columns: clipped.length ? Object.keys(clipped[0]) : [],
    rows: clipped,
    row_count: clipped.length,
    truncated,
    elapsed_ms: elapsedMs,
  };
}

module.exports = { schema, query };
