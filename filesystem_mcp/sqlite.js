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

const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SQLITE_BIN = 'sqlite3';
const SQLITE_HEADER = 'SQLite format 3\0'; // exactly 16 bytes

const DEFAULT_LIMIT = 100, MAX_LIMIT = 1000;
const DEFAULT_TIMEOUT_MS = 5000, MAX_TIMEOUT_MS = 30000;
const DEFAULT_COUNTS_TIMEOUT_MS = 60000, MAX_COUNTS_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_STDOUT_BYTES = 1024 * 1024; // 1 MiB ceiling on sqlite3's stdout

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
      throw new Error(`NOT_SQLITE: ${p} is not a SQLite database — first ${n} byte(s): ${head.toString('hex')}`);
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

async function runSqlite(dbPath, sql, timeoutMs) {
  let res;
  try { res = await spawnSqlite3(['-readonly', '-safe', '-json', dbPath, sql], { timeoutMs }); }
  catch (err) { throw mapSpawnError(err, dbPath, timeoutMs); }
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
    note: `did not finish within counts_timeout_ms=${countsTimeoutMs} (a per-table budget that also covers spawning sqlite3 and opening the database file, not just the COUNT(*) itself) — raise counts_timeout_ms, or run SELECT COUNT(*) via sqlite_query with its own timeout_ms for just one of these tables`,
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
