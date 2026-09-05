#!/usr/bin/env node
/**
 * Vault MCP Server — StreamableHTTP транспорт
 * Полная замена supergateway + @modelcontextprotocol/server-filesystem
 * Добавляет: read_pdf_page (JPEG) и read_pdf_text (pdftotext)
 */

const http = require('http');
const { execFile, fork } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');
const P = require('./policy');

// grep_files runs in a forked copy of THIS file (argv: --grep-worker <vault>).
// Rationale: node has no way to time out a regex. A catastrophically
// backtracking pattern ((a+)+$ on a long run of 'a') wedges the event loop and
// takes the whole MCP server with it — and this addon listens on a port. A
// child process can simply be SIGKILLed. See grepSpawn().
const GREP_WORKER = process.argv[2] === '--grep-worker';

const VERSION = process.env.ADDON_VERSION || '0.0.0-dev';
const ALLOWED_DIR = path.resolve((GREP_WORKER ? process.argv[3] : process.argv[2]) || '/media/VAULT');
const PORT = parseInt(process.argv[3] || '3099');

// Real path of the vault, resolved once. The vault root itself is often reached
// through a symlink on HAOS (/media → /mnt/data/supervisor/media), so escape
// checks must compare against the resolved root, not the literal one.
let REAL_ROOT = ALLOWED_DIR;
try { REAL_ROOT = fs.realpathSync(ALLOWED_DIR); } catch {}

function inside(p, root) {
  return p === root || p.startsWith(root + path.sep);
}

// Hardened in 2.5.0. Two holes were closed:
//   1. startsWith(ALLOWED_DIR) alone accepted sibling directories whose name
//      merely shares the prefix (/media/VAULT_backup passed for /media/VAULT).
//   2. Symlinks inside the vault pointing outside it were followed silently —
//      `..` was blocked, a symlink was not.
// For paths that do not exist yet (write_file, create_directory, move_file
// destinations) the nearest existing ancestor is resolved instead.
function resolveSafe(p) {
  if (typeof p !== 'string' || !p) throw new Error('path must be a non-empty string');
  const resolved = path.resolve(p);
  if (!inside(resolved, ALLOWED_DIR)) throw new Error(`Access denied: ${p}`);
  let probe = resolved;
  for (;;) {
    try {
      const real = fs.realpathSync(probe);
      if (!inside(real, REAL_ROOT)) throw new Error(`Access denied (symlink escapes the vault): ${p}`);
      return resolved;
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
      const parent = path.dirname(probe);
      if (parent === probe || !inside(parent, ALLOWED_DIR)) throw new Error(`Access denied: ${p}`);
      probe = parent;
    }
  }
}

// Short content digest used as an optimistic lock for line-addressed edits.
function revOf(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 8);
}

function revOfFile(p) {
  return revOf(fs.readFileSync(p, 'utf8'));
}

// ---------------------------------------------------------------------------
// Policy enforcement (2.6.0)
// ---------------------------------------------------------------------------
// Markers are read on every call — there is no cache between calls, so a policy
// changed on the page takes effect on the next tool call. `memo` is created per
// call and dies with it.

function policyOfDir(dir, memo) {
  return P.policyForDir(dir, ALLOWED_DIR, memo);
}

function assertNotMarker(p, verb) {
  if (path.basename(p) === P.POLICY_FILE)
    throw new Error(`${P.POLICY_FILE} cannot be ${verb} through MCP tools — the marker is owned by the add-on's "Vault policies" page (Home Assistant sidebar). A directory or file of that name created here would lock the zone with no way to repair it from this side.`);
}

// Common gate for anything that changes the tree at `p`. Returns the effective
// policy of the directory that holds p.
function guardWrite(p, memo, verb) {
  assertNotMarker(p, verb);
  const dir = path.dirname(p);
  const policy = policyOfDir(dir, memo);
  if (policy.error) throw new Error(`Refused — ${policy.error}`);
  if (policy.readonly)
    throw new Error(`Refused — ${dir} is read-only by policy (${P.describePolicy(policy, dir)}). Nothing was written.`);
  return policy;
}

// Second gate: the object already exists, so this is a change to existing
// content rather than a creation.
function guardOverwrite(p, policy, rev, what) {
  if (!fs.existsSync(p)) return false;
  if (policy.overwrite === 'never')
    throw new Error(`Refused — policy "overwrite: never" (${P.describePolicy(policy, path.dirname(p))}): ${p} already exists and existing files may not be ${what}. Nothing was written.`);
  if (policy.overwrite === 'rev') {
    let cur;
    try { cur = revOfFile(p); }
    catch (e) { throw new Error(`Refused — policy "overwrite: rev", but the current rev of ${p} cannot be read (${e.message}).`); }
    if (rev === undefined || rev === null || rev === '')
      throw new Error(`Refused — policy "overwrite: rev": changing an existing file requires its current rev, which is ${cur}. Nothing was written. Repeat the call with rev: "${cur}".`);
    if (String(rev) !== cur)
      throw new Error(`rev mismatch: file is now ${cur}, you passed ${rev}. It changed since you read it — NOTHING was written. Re-read (grep_files / read_text_file offset / get_file_info) and redo the edit.`);
  }
  return true;
}

// Moving a file OUT of a strict zone needs the same rev as overwriting it in
// place. Without this the whole thing is bypassed in three steps: move to a
// free zone, edit there, move back — the way back counts as a creation.
function guardTakeOut(p, policy, rev, verb) {
  if (policy.overwrite === 'never')
    throw new Error(`Refused — policy "overwrite: never" (${P.describePolicy(policy, path.dirname(p))}): existing files may not be ${verb} out of this zone.`);
  if (policy.overwrite === 'rev') {
    const cur = revOfFile(p);
    if (rev === undefined || rev === null || rev === '')
      throw new Error(`Refused — policy "overwrite: rev": taking a file out of this zone requires its current rev, which is ${cur}. Read it first, then repeat with rev: "${cur}".`);
    if (String(rev) !== cur)
      throw new Error(`rev mismatch: file is now ${cur}, you passed ${rev}. Nothing was moved.`);
  }
}

// A trash directory that no marker claims any more. Left strictly alone, but
// said out loud so it is not mistaken for a live one.
function orphanTrashNote(dir, policy) {
  const live = P.trashDirOf(policy);
  const names = new Set([P.DEFAULT_TRASH]);
  if (policy.trash) names.add(policy.trash);
  const notes = [];
  for (const n of names) {
    const cand = path.join(dir, n);
    if (cand === live) continue;
    try { if (fs.lstatSync(cand).isDirectory()) notes.push(`⚠ ${cand} looks like a trash directory but no policy in force claims it — left alone.`); } catch {}
  }
  return notes;
}

// Split preserving the information needed to rebuild the file byte-for-byte:
// a trailing newline must not become a phantom empty last line.
function splitLines(text) {
  if (text === '') return { lines: [], eol: false };
  const eol = text.endsWith('\n');
  const lines = text.split('\n');
  if (eol) lines.pop();
  return { lines, eol };
}

function joinLines(lines, eol) {
  return lines.join('\n') + (eol ? '\n' : '');
}

function stripBom(text) {
  return text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;
}

function clip(s, max) {
  s = String(s).replace(/\r$/, '');
  return s.length > max ? s.slice(0, max) + '…' : s;
}

function toInt(v, name) {
  const n = typeof v === 'string' ? parseInt(v, 10) : v;
  if (typeof n !== 'number' || !Number.isFinite(n)) throw new Error(`${name} must be a number`);
  return Math.trunc(n);
}

// Fix for issue #2: some MCP clients (claude.ai / Claude Desktop) serialize
// array parameters as JSON strings instead of native arrays.
// Defensively parse them back before use.
function coerceArray(v, name) {
  if (typeof v === 'string') {
    try { v = JSON.parse(v); }
    catch { throw new Error(`${name} is a JSON string but failed to parse`); }
  }
  if (!Array.isArray(v)) throw new Error(`${name} must be an array`);
  return v;
}

async function pdfPageCount(p) {
  return new Promise(resolve => {
    execFile('pdfinfo', [p], (err, stdout) => {
      const m = (stdout || '').match(/Pages:\s+(\d+)/);
      resolve(m ? parseInt(m[1]) : 1);
    });
  });
}

async function pdfPageToImage(p, n) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vmcp-'));
  try {
    await new Promise((res, rej) => execFile('pdftoppm', [
      '-jpeg', '-r', '120', '-scale-to', '1400',
      '-f', String(n), '-l', String(n),
      p, path.join(tmp, 'page')
    ], e => e ? rej(e) : res()));
    const files = fs.readdirSync(tmp).filter(f => f.endsWith('.jpg')).sort();
    if (!files.length) throw new Error('pdftoppm: no output');
    return { type: 'image', data: fs.readFileSync(path.join(tmp, files[0])).toString('base64'), mimeType: 'image/jpeg' };
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
}

async function pdfToText(p, first, last) {
  return new Promise((res, rej) => {
    execFile('pdftotext', [
      '-layout', '-f', String(first), '-l', String(last), p, '-'
    ], { maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => err ? rej(err) : res(stdout));
  });
}

function mimeType(ext) {
  const map = {
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
    '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp',
    '.svg': 'image/svg+xml', '.mp3': 'audio/mpeg', '.wav': 'audio/wav',
    '.ogg': 'audio/ogg', '.flac': 'audio/flac',
  };
  return map[ext.toLowerCase()] || 'application/octet-stream';
}

function listDir(p) {
  return fs.readdirSync(p, { withFileTypes: true })
    .map(e => `${e.isDirectory() ? '[DIR]' : '[FILE]'} ${e.name}`).join('\n');
}

function listDirWithSizes(p, sortBy = 'name') {
  const entries = fs.readdirSync(p, { withFileTypes: true });
  const items = entries.map(e => {
    const full = path.join(p, e.name);
    let size = 0;
    try { size = e.isFile() ? fs.statSync(full).size : 0; } catch {}
    return { isDir: e.isDirectory(), name: e.name, size };
  });
  if (sortBy === 'size') items.sort((a, b) => b.size - a.size);
  else items.sort((a, b) => a.name.localeCompare(b.name));
  const lines = items.map(i =>
    `${i.isDir ? '[DIR]' : '[FILE]'} ${i.name}${i.isDir ? '' : '  ' + (i.size / 1024).toFixed(2) + ' KB'}`
  );
  const total = items.filter(i => !i.isDir).reduce((s, i) => s + i.size, 0);
  return lines.join('\n') + `\n\nTotal: ${items.filter(i => !i.isDir).length} files, ${items.filter(i => i.isDir).length} directories\nCombined size: ${(total / 1024).toFixed(2)} KB`;
}

// Trash directories are omitted: a discarded page that keeps turning up in a
// tree (or a grep) gets read and quoted again as if it were live. The count of
// omissions is printed, so nothing disappears silently.
function dirTree(p, memo, policy, level, hidden) {
  level = level || 0;
  if (level > 2) return '';
  const trash = P.trashDirOf(policy);
  const indent = '  '.repeat(level);
  return fs.readdirSync(p, { withFileTypes: true }).map(e => {
    const full = path.join(p, e.name);
    if (e.isDirectory() && trash && full === trash) { hidden.n++; return null; }
    const line = `${indent}${e.isDirectory() ? '[DIR]' : '[FILE]'} ${e.name}`;
    if (e.isDirectory() && level < 2) {
      const sub = dirTree(full, memo, P.applyMarker(policy, full, memo), level + 1, hidden);
      return line + (sub ? '\n' + sub : '');
    }
    return line;
  }).filter(l => l !== null).join('\n');
}

// ---------------------------------------------------------------------------
// grep_files
// ---------------------------------------------------------------------------

const GREP_TIMEOUT_MS = 10000;      // hard wall-clock cap, then SIGKILL
const GREP_MAX_FILE = 20 * 1024 * 1024;
const GREP_MAX_BYTES = 60000;       // ceiling on the rendered answer itself
const GREP_SKIP_DIRS = new Set(['.git', 'node_modules', '.svn', '.hg']);

// Glob → RegExp against the basename. Comma-separated alternatives allowed:
// "*.md,*.yaml". Only * and ? are special.
function globToRe(glob) {
  const parts = String(glob).split(',').map(s => s.trim()).filter(Boolean);
  if (!parts.length) return null;
  const src = parts.map(g =>
    '^' + g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$'
  ).join('|');
  return new RegExp(src);
}

// Long lines are clipped AROUND the match, not from the start: in this vault a
// single line can be several KB, and a head-clip would routinely hide the very
// thing that matched.
function clipAround(line, at, len, max) {
  if (line.length <= max) return line;
  const lead = Math.floor(max / 3);
  let start = Math.max(0, at - lead);
  let end = Math.min(line.length, start + max);
  start = Math.max(0, end - max);
  return (start > 0 ? '…' : '') + line.slice(start, end) + (end < line.length ? '…' : '');
}

function grepRun(job) {
  const t0 = Date.now();
  const re = new RegExp(job.pattern, job.ignoreCase ? 'i' : '');
  const incRe = job.include ? globToRe(job.include) : null;
  const excRe = job.exclude ? globToRe(job.exclude) : null;
  const maxLine = job.maxLineLength;

  const files = [];
  const st = fs.lstatSync(job.root);
  if (st.isFile()) {
    files.push(job.root);
  } else if (st.isDirectory()) {
    const memo = new Map();
    const walk = (dir, policy) => {
      const trash = P.trashDirOf(policy);
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isSymbolicLink()) continue;               // no loops, no escapes
        if (e.isDirectory()) {
          if (GREP_SKIP_DIRS.has(e.name)) continue;
          if (trash && full === trash) continue;        // trash is not searchable
          if (excRe && excRe.test(e.name)) continue;
          walk(full, P.applyMarker(policy, full, memo));
        } else if (e.isFile()) {
          if (excRe && excRe.test(e.name)) continue;
          if (incRe && !incRe.test(e.name)) continue;
          files.push(full);
        }
      }
    };
    walk(job.root, P.policyForDir(job.root, ALLOWED_DIR, memo));
  } else {
    throw new Error(`not a file or directory: ${job.root}`);
  }
  files.sort();

  const out = [];
  let bytes = 0, matches = 0, scanned = 0, scannedBytes = 0, skippedBinary = 0, skippedBig = 0;
  let truncated = null;

  outer:
  for (const file of files) {
    let size;
    try { size = fs.statSync(file).size; } catch { continue; }
    if (size > GREP_MAX_FILE) { skippedBig++; continue; }
    let buf;
    try { buf = fs.readFileSync(file); } catch { continue; }
    if (buf.subarray(0, 4096).includes(0)) { skippedBinary++; continue; }
    scanned++; scannedBytes += size;

    const { lines } = splitLines(stripBom(buf.toString('utf8')));
    const hits = [];
    for (let i = 0; i < lines.length; i++) {
      const m = re.exec(lines[i]);
      if (m) hits.push({ n: i + 1, at: m.index });
    }
    if (!hits.length) continue;

    // Assemble the printable window set (match ± context), merging overlaps.
    const want = new Map();
    for (const h of hits) {
      const from = Math.max(1, h.n - job.context);
      const to = Math.min(lines.length, h.n + job.context);
      for (let n = from; n <= to; n++) if (!want.has(n)) want.set(n, false);
      want.set(h.n, true);
    }
    const nums = [...want.keys()].sort((a, b) => a - b);

    const head = `${file} · rev ${revOf(buf.toString('utf8'))} · ${lines.length} lines`;
    const block = [head];
    bytes += head.length + 2;
    let prev = null, stop = null;
    for (const n of nums) {
      if (prev !== null && n > prev + 1) { block.push('  --'); bytes += 5; }
      const isHit = want.get(n);
      const raw = lines[n - 1].replace(/\r$/, '');
      const at = isHit ? (hits.find(h => h.n === n) || { at: 0 }).at : 0;
      const rendered = `  ${n}${isHit ? ':' : '-'} ${clipAround(raw, at, raw.length, maxLine)}`;
      block.push(rendered);
      bytes += rendered.length + 1;
      prev = n;
      if (isHit) matches++;
      // Both caps are checked per rendered line, not per file: a single file can
      // hold thousands of matching multi-KB lines, and a per-file check would let
      // one file blow the whole budget before anyone looks at it.
      if (isHit && matches >= job.maxResults) { stop = `max_results=${job.maxResults} reached`; break; }
      if (bytes > GREP_MAX_BYTES) { stop = `response byte cap (${GREP_MAX_BYTES} B) reached`; break; }
    }
    out.push(block.join('\n'));
    if (stop) { truncated = stop; break outer; }
  }

  return {
    body: out.join('\n\n'),
    matches, files: out.length, scanned, scannedBytes,
    skippedBinary, skippedBig, truncated, ms: Date.now() - t0,
    totalFiles: files.length
  };
}

function grepSpawn(job) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      // execArgv: [] is load-bearing — fork() inherits the parent's node flags
      // by default, and a parent started as `node -e "..."` would otherwise
      // re-run that script in the child instead of server.js (fork bomb).
      child = fork(__filename, ['--grep-worker', ALLOWED_DIR], {
        execArgv: [], stdio: ['ignore', 'ignore', 'pipe', 'ipc']
      });
    } catch (e) { reject(e); return; }
    let settled = false;
    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill('SIGKILL'); } catch {}
      fn(arg);
    };
    const timer = setTimeout(() => finish(reject, new Error(
      `grep timed out after ${GREP_TIMEOUT_MS / 1000}s and was killed. The pattern is probably catastrophically backtracking (e.g. nested quantifiers like (a+)+) or the tree is too large — simplify the pattern, or narrow path/include.`
    )), GREP_TIMEOUT_MS);
    child.on('message', msg => msg && msg.error
      ? finish(reject, new Error(msg.error))
      : finish(resolve, msg));
    child.on('error', e => finish(reject, e));
    child.on('exit', code => finish(reject, new Error(`grep worker exited unexpectedly (code ${code})`)));
    child.send(job);
  });
}

const TOOLS = [
  {
    name: 'grep_files',
    description: 'Search file CONTENTS by regex, recursively. Per file returns path, rev, line count, then matching line numbers with their text. Long lines are clipped around the match (max_line_length, default 200). Line numbers and rev feed straight into read_text_file offset/limit and edit_file line edits. Binaries and symlinks are skipped; output is capped and flags truncation when incomplete.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File or directory (recursive)' },
        pattern: { type: 'string', description: 'JavaScript regex' },
        ignore_case: { type: 'boolean' },
        include: { type: 'string', description: 'Filename glob, comma-separated: "*.md,*.yaml"' },
        exclude: { type: 'string', description: 'Glob to skip' },
        context: { type: 'number', description: '±N lines around each match (default 0)' },
        max_results: { type: 'number', description: 'Default 50' },
        max_line_length: { type: 'number', description: 'Default 200' }
      },
      required: ['path', 'pattern']
    }
  },
  {
    name: 'read_text_file',
    description: 'Read a text file. Whole file by default; head/tail = N lines from an edge; offset/limit = an arbitrary 1-based line range, which also reports total lines and rev (needed for edit_file line edits).',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        head: { type: 'number' },
        tail: { type: 'number' },
        offset: { type: 'number', description: 'First line, 1-based' },
        limit: { type: 'number', description: 'Number of lines from offset' }
      },
      required: ['path']
    }
  },
  {
    name: 'read_file',
    description: 'DEPRECATED alias of read_text_file.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' }, head: { type: 'number' }, tail: { type: 'number' }, offset: { type: 'number' }, limit: { type: 'number' } }, required: ['path'] }
  },
  {
    name: 'read_media_file',
    description: 'Read an image, audio or PDF file. PDF returns one page (default 1, or "#N" path suffix) as JPEG plus the total page count.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }
  },
  {
    name: 'read_pdf_page',
    description: 'Render one PDF page (1-based) as JPEG. Prefer read_pdf_text unless layout or graphics matter.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' }, page: { type: 'number' } },
      required: ['path', 'page']
    }
  },
  {
    name: 'read_pdf_text',
    description: 'Extract text from a PDF (pdftotext -layout), whole document or a page range. Much cheaper than page images — prefer it; fall back to read_pdf_page for scans.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' }, first_page: { type: 'number' }, last_page: { type: 'number' } },
      required: ['path']
    }
  },
  {
    name: 'read_multiple_files',
    description: 'Read several whole files at once.',
    inputSchema: { type: 'object', properties: { paths: { type: 'array', items: { type: 'string' } } }, required: ['paths'] }
  },
  {
    name: 'write_file',
    description: 'Create or overwrite a file with given content. In a zone with policy overwrite="rev", overwriting an EXISTING file requires its current rev (creating a new one does not); the refusal message carries the rev to use.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' }, rev: { type: 'string', description: 'Current rev of the file being overwritten. From grep_files, read_text_file offset, or get_file_info.' } }, required: ['path', 'content'] }
  },
  {
    name: 'edit_file',
    description: 'Edit a file. Two mutually exclusive edit shapes: {oldText,newText} literal replacement, or line edits (1-based). {startLine,endLine,newText} replaces the inclusive range; newText "" deletes, no trailing newline. Omitting endLine INSERTS before startLine instead of replacing, and startLine = lines+1 appends at EOF. Line edits require rev and are applied bottom-up in one atomic pass, so numbers from a single grep/read stay valid; a stale rev is rejected, never applied. Returns the new rev. dryRun shows the diff. In a zone with policy overwrite="rev" every edit needs rev, including {oldText}; in overwrite="never" zones editing is refused outright.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        edits: { type: 'array', items: { type: 'object', properties: { oldText: { type: 'string' }, newText: { type: 'string' }, startLine: { type: 'number' }, endLine: { type: 'number' } }, required: ['newText'] } },
        rev: { type: 'string', description: 'From grep_files, read_text_file offset, or get_file_info' },
        dryRun: { type: 'boolean' }
      },
      required: ['path', 'edits']
    }
  },
  {
    name: 'create_directory',
    description: 'Create a directory (and parents if needed).',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }
  },
  {
    name: 'list_directory',
    description: 'List files and directories in a path.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }
  },
  {
    name: 'list_directory_with_sizes',
    description: 'List a directory with file sizes, sorted by name or size.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' }, sortBy: { type: 'string', enum: ['name', 'size'] } }, required: ['path'] }
  },
  {
    name: 'directory_tree',
    description: 'Recursive tree view, 2 levels deep.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }
  },
  {
    name: 'move_file',
    description: 'Move or rename a file or directory. Taking a file out of a zone with policy overwrite="rev" requires its current rev, exactly like overwriting it in place; directories are not moved out of a strict zone at all. Use trash_file, not this, to discard something.',
    inputSchema: { type: 'object', properties: { source: { type: 'string' }, destination: { type: 'string' }, rev: { type: 'string', description: 'Current rev of the source file, required when it leaves a zone with overwrite="rev".' } }, required: ['source', 'destination'] }
  },
  {
    name: 'trash_file',
    description: 'Discard a file by moving it into the trash of its own zone, keeping its relative path and adding an arrival timestamp to the name. There is no delete: this is the only way to remove something. Fails if the zone has no trash configured. In a zone with overwrite="rev" the current rev is required — you have to read a file before throwing it away.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' }, rev: { type: 'string', description: 'Current rev of the file, required in a zone with overwrite="rev".' } }, required: ['path'] }
  },
  {
    name: 'search_files',
    description: 'Find files by NAME substring, recursively. For content use grep_files.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' }, pattern: { type: 'string' }, excludePatterns: { type: 'array', items: { type: 'string' } } },
      required: ['path', 'pattern']
    }
  },
  {
    name: 'get_file_info',
    description: 'Metadata for a file or directory: size, times, plus line count and rev for text files.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }
  },
  {
    name: 'list_allowed_directories',
    description: 'List all directories this server is allowed to access.',
    inputSchema: { type: 'object', properties: {} }
  },
];

async function callTool(name, args) {
  // One memo per tool call: policy markers are read fresh every call, and
  // within a call the same marker is not read twice. It dies with the call, so
  // there is no stale cache anywhere.
  const memo = new Map();

  switch (name) {
    case 'read_file':
    case 'read_text_file': {
      const p = resolveSafe(args.path);
      let text = fs.readFileSync(p, 'utf8');
      // offset/limit is the only branch that changes the response shape, and it
      // is opt-in: head/tail and the plain read stay byte-identical to <=2.4.1.
      if (args.offset !== undefined || args.limit !== undefined) {
        const { lines } = splitLines(stripBom(text));
        const start = args.offset === undefined ? 1 : toInt(args.offset, 'offset');
        if (start < 1) throw new Error('offset is 1-based, must be >= 1');
        if (start > lines.length) throw new Error(`offset ${start} is past the end of the file (${lines.length} lines)`);
        const limit = args.limit === undefined ? lines.length : toInt(args.limit, 'limit');
        if (limit < 1) throw new Error('limit must be >= 1');
        const end = Math.min(lines.length, start + limit - 1);
        const head = `${p} · rev ${revOf(text)} · lines ${start}-${end} of ${lines.length}`;
        return [{ type: 'text', text: `${head}\n${lines.slice(start - 1, end).join('\n')}` }];
      }
      // head/tail must slice the same line array as everything else. Until
      // 2.5.1 they cut the raw split('\n'), where a trailing newline leaves a
      // phantom empty element at the END: harmless for head, but it ate one
      // slot of every tail=N on a file ending with a newline — that is, on
      // nearly every file. splitLines() drops the phantom. Output is otherwise
      // byte-identical to <=2.5.0, except that tail no longer trails a newline.
      if (args.head) text = splitLines(text).lines.slice(0, args.head).join('\n');
      else if (args.tail) text = splitLines(text).lines.slice(-args.tail).join('\n');
      return [{ type: 'text', text }];
    }

    case 'grep_files': {
      const root = resolveSafe(args.path);
      if (typeof args.pattern !== 'string' || !args.pattern) throw new Error('pattern must be a non-empty string');
      // Fail fast and legibly on a broken regex instead of paying for a fork.
      try { new RegExp(args.pattern); }
      catch (e) { throw new Error(`invalid regex: ${e.message}`); }
      const job = {
        root,
        pattern: args.pattern,
        ignoreCase: args.ignore_case === true || args.ignore_case === 'true',
        include: args.include || null,
        exclude: args.exclude || null,
        context: Math.max(0, Math.min(20, args.context === undefined ? 0 : toInt(args.context, 'context'))),
        maxResults: Math.max(1, Math.min(1000, args.max_results === undefined ? 50 : toInt(args.max_results, 'max_results'))),
        maxLineLength: Math.max(40, Math.min(4000, args.max_line_length === undefined ? 200 : toInt(args.max_line_length, 'max_line_length')))
      };
      const r = await grepSpawn(job);
      const notes = [];
      if (r.skippedBinary) notes.push(`${r.skippedBinary} binary skipped`);
      if (r.skippedBig) notes.push(`${r.skippedBig} over-size skipped`);
      const footer = `— ${r.matches} match(es) in ${r.files} file(s) · scanned ${r.scanned}/${r.totalFiles} files, ${(r.scannedBytes / 1024).toFixed(0)} KB, ${r.ms} ms` +
        (notes.length ? ` · ${notes.join(', ')}` : '');
      if (!r.matches) return [{ type: 'text', text: `No matches.\n${footer}` }];
      const warn = r.truncated
        ? `\n⚠ TRUNCATED — ${r.truncated}. This list is INCOMPLETE; do not treat it as all matches. Narrow the pattern/include or raise max_results.`
        : '';
      return [{ type: 'text', text: `${r.body}\n\n${footer}${warn}` }];
    }

    case 'read_media_file': {
      const rawPath = args.path;
      const hashIdx = rawPath.lastIndexOf('#');
      const pageNum = hashIdx !== -1 ? parseInt(rawPath.slice(hashIdx + 1)) || 1 : 1;
      const cleanPath = hashIdx !== -1 ? rawPath.slice(0, hashIdx) : rawPath;
      const p = resolveSafe(cleanPath);
      const ext = path.extname(p).toLowerCase();
      if (ext === '.pdf') {
        const [totalPages, block] = await Promise.all([pdfPageCount(p), pdfPageToImage(p, pageNum)]);
        return [{ type: 'text', text: `Page ${pageNum} of ${totalPages}` }, block];
      }
      const data = fs.readFileSync(p).toString('base64');
      const mime = mimeType(ext);
      if (mime.startsWith('image/')) return [{ type: 'image', data, mimeType: mime }];
      if (mime.startsWith('audio/')) return [{ type: 'audio', data, mimeType: mime }];
      return [{ type: 'text', text: `Unsupported media type: ${mime}` }];
    }

    case 'read_pdf_page': {
      const p = resolveSafe(args.path);
      const n = parseInt(args.page) || 1;
      const total = await pdfPageCount(p);
      if (n < 1 || n > total) throw new Error(`Page ${n} out of range (1-${total})`);
      const block = await pdfPageToImage(p, n);
      return [{ type: 'text', text: `Page ${n} of ${total}` }, block];
    }

    case 'read_pdf_text': {
      const p = resolveSafe(args.path);
      if (path.extname(p).toLowerCase() !== '.pdf') throw new Error(`Not a PDF file: ${p}`);
      const total = await pdfPageCount(p);
      const first = args.first_page !== undefined ? parseInt(args.first_page) || 1 : 1;
      const last = args.last_page !== undefined ? parseInt(args.last_page) || total : total;
      if (first < 1 || last > total || first > last) throw new Error(`Page range ${first}-${last} out of range (1-${total})`);
      const text = (await pdfToText(p, first, last)).trim();
      const header = `Pages ${first}-${last} of ${total}`;
      if (!text) return [{ type: 'text', text: `${header}\n\n(no extractable text — the PDF is likely scanned; use read_pdf_page to view pages as images)` }];
      return [{ type: 'text', text: `${header}\n\n${text}` }];
    }

    case 'read_multiple_files': {
      const paths = coerceArray(args.paths, 'paths');
      const results = [];
      for (const fp of paths) {
        try {
          const p = resolveSafe(fp);
          // Bulk reads must not scoop discarded versions back into context.
          // A single deliberate read_text_file still opens them.
          const trash = P.trashDirOf(policyOfDir(path.dirname(p), memo));
          if (trash && P.inside(p, trash))
            throw new Error('this file is in the trash — bulk reads skip it; open it with read_text_file if you really want it');
          results.push(`=== ${fp} ===\n${fs.readFileSync(p, 'utf8')}`);
        }
        catch (e) { results.push(`=== ${fp} ===\nERROR: ${e.message}`); }
      }
      return [{ type: 'text', text: results.join('\n\n') }];
    }

    case 'write_file': {
      const p = resolveSafe(args.path);
      const policy = guardWrite(p, memo, 'written');
      const existed = guardOverwrite(p, policy, args.rev, 'overwritten');
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, args.content, 'utf8');
      return [{ type: 'text', text: `${existed ? 'Overwritten' : 'Written'}: ${p} · rev ${revOf(args.content)}` }];
    }

    case 'edit_file': {
      const p = resolveSafe(args.path);
      const edits = coerceArray(args.edits, 'edits');
      const dry = args.dryRun === true || args.dryRun === 'true';
      // The policy is checked for a dry run too: better to learn that the zone
      // is locked before composing the edit than after.
      const policy = guardWrite(p, memo, 'edited');
      let text = fs.readFileSync(p, 'utf8');
      const rev0 = revOf(text);
      guardOverwrite(p, policy, args.rev, 'edited');

      const byLine = edits.some(e => e && (e.startLine !== undefined || e.endLine !== undefined));
      const byText = edits.some(e => e && e.oldText !== undefined);
      if (byLine && byText) throw new Error('do not mix {oldText} and {startLine} edits in one call — send two calls');

      // Optimistic lock. Silently applying an edit against stale line numbers is
      // the worst possible outcome (quiet corruption at an unreviewed spot), so
      // a mismatch is a hard error and nothing is written.
      if (args.rev !== undefined && String(args.rev) !== rev0)
        throw new Error(`rev mismatch: file is now ${rev0}, you passed ${args.rev}. It changed since you read it — NOTHING was written. Re-read (grep_files / read_text_file offset / get_file_info) and redo the edit.`);

      if (byLine) {
        if (args.rev === undefined)
          throw new Error('line edits require rev — refusing to edit by line numbers that may be stale. Get rev from grep_files, read_text_file with offset, or get_file_info.');
        const { lines, eol } = splitLines(text);
        const before = lines.length;
        const crlf = /\r\n/.test(text.slice(0, 65536));
        const norm = edits.map((e, i) => {
          if (!e || typeof e.newText !== 'string') throw new Error(`edit #${i + 1}: newText must be a string ("" deletes the lines)`);
          const s = toInt(e.startLine, `edit #${i + 1} startLine`);
          // One shape, one meaning (2.5.2): omitting endLine INSERTS before
          // startLine — the empty range startLine … startLine-1 — and
          // startLine = lines+1 is that same insert landing at EOF, i.e. an
          // append. Replacing a line requires an explicit endLine.
          // Until 2.5.2 a missing endLine silently meant "replace line
          // startLine", so an append aimed one line short quietly ate a line
          // instead of adding one: the exact silent corruption that line
          // addressing exists to prevent. Inserting into the middle of a file
          // was impossible at the same time.
          const insert = e.endLine === undefined;
          const en = insert ? s - 1 : toInt(e.endLine, `edit #${i + 1} endLine`);
          if (s < 1) throw new Error(`edit #${i + 1}: bad startLine ${s} (1-based)`);
          if (insert) {
            if (s > before + 1) throw new Error(`edit #${i + 1}: startLine ${s} is past the end of the file (${before} lines) — the last insert position is ${before + 1}`);
            if (e.newText === '') throw new Error(`edit #${i + 1}: newText "" at an insert position (line ${s}) deletes nothing — drop the edit instead`);
          } else {
            if (en < s) throw new Error(`edit #${i + 1}: bad range ${s}-${en} (1-based, endLine >= startLine)`);
            if (en > before) throw new Error(`edit #${i + 1}: endLine ${en} is past the end of the file (${before} lines) — omit endLine to insert instead of replacing (startLine ${before + 1} appends at EOF)`);
          }
          return { s, en, newText: e.newText, insert };
        }).sort((a, b) => b.s - a.s);
        // Every pair is checked explicitly. An insert is an empty range, so the
        // old "next.end < this.start" sweep would have let two inserts share one
        // position (the bottom-up pass would silently swap them) and let an
        // insert land inside a range being replaced (undefined whose text wins).
        for (let i = 0; i < norm.length; i++)
          for (let j = i + 1; j < norm.length; j++) {
            const a = norm[i], b = norm[j];
            if (a.insert && b.insert) {
              if (a.s === b.s) throw new Error(`two inserts at the same position (line ${a.s}) in one call — merge them into one newText`);
            } else if (a.insert !== b.insert) {
              const ins = a.insert ? a : b, rep = a.insert ? b : a;
              if (ins.s >= rep.s && ins.s <= rep.en)
                throw new Error(`insert at line ${ins.s} falls inside the replaced range ${rep.s}-${rep.en} — send it as a separate call`);
            } else if (a.s <= b.en && b.s <= a.en) {
              throw new Error(`edits overlap: lines ${b.s}-${b.en} and ${a.s}-${a.en}`);
            }
          }
        // Applied bottom-up, so earlier edits never shift later ones.
        const preview = [];
        for (const e of norm) {
          const removed = lines.slice(e.s - 1, e.en);
          // splitLines() cuts on \n only, so in a CRLF file every stored line
          // still ends with \r. Inserted lines must carry it too, otherwise the
          // file silently ends up with mixed line endings.
          const insLines = e.newText === '' ? []
            : e.newText.split('\n').map(l => crlf ? l.replace(/\r$/, '') + '\r' : l);
          if (dry) preview.unshift(
            (e.insert
              ? (e.s === before + 1
                  ? `@@ append after line ${before}: +${insLines.length} line(s)\n`
                  : `@@ insert before line ${e.s}: +${insLines.length} line(s)\n`)
              : `@@ ${e.s}-${e.en}: ${removed.length} → ${insLines.length} line(s)\n`) +
            removed.map(l => '- ' + clip(l, 160)).join('\n') +
            (insLines.length ? '\n' + insLines.map(l => '+ ' + clip(l, 160)).join('\n') : '')
          );
          lines.splice(e.s - 1, e.en - e.s + 1, ...insLines);
        }
        const out = joinLines(lines, eol);
        if (!dry) fs.writeFileSync(p, out, 'utf8');
        const rev1 = revOf(out);
        return [{ type: 'text', text:
          `${dry ? '[DRY RUN] ' : ''}${norm.length} line edit(s) — ${p}\n` +
          `lines ${before} → ${lines.length} · rev ${rev0} → ${rev1}` +
          (dry ? '\n\n' + preview.join('\n') : '') }];
      }

      for (const edit of edits) {
        if (!edit || typeof edit.oldText !== 'string' || typeof edit.newText !== 'string')
          throw new Error('each edit must be an object with string oldText and newText');
        if (!text.includes(edit.oldText)) throw new Error(`oldText not found: "${edit.oldText.slice(0, 60)}"`);
        text = text.replace(edit.oldText, edit.newText);
      }
      if (!dry) fs.writeFileSync(p, text, 'utf8');
      return [{ type: 'text', text: `${dry ? '[DRY RUN] ' : ''}${edits.length} edit(s) applied to ${p} · rev ${rev0} → ${revOf(text)}` }];
    }

    case 'create_directory': {
      const p = resolveSafe(args.path);
      // The marker-name check matters most here: a DIRECTORY named
      // .vault-policy is unreadable as a marker, so the zone fails closed and
      // cannot be repaired with these tools at all.
      guardWrite(p, memo, 'created');
      fs.mkdirSync(p, { recursive: true });
      return [{ type: 'text', text: `Created: ${p}` }];
    }

    case 'list_directory': {
      const p = resolveSafe(args.path);
      const policy = policyOfDir(p, memo);
      const notes = orphanTrashNote(p, policy);
      return [{ type: 'text', text: [P.describePolicy(policy, p), ...notes, '', listDir(p)].join('\n') }];
    }

    case 'list_directory_with_sizes': {
      const p = resolveSafe(args.path);
      const policy = policyOfDir(p, memo);
      const notes = orphanTrashNote(p, policy);
      return [{ type: 'text', text: [P.describePolicy(policy, p), ...notes, '', listDirWithSizes(p, args.sortBy)].join('\n') }];
    }

    case 'directory_tree': {
      const p = resolveSafe(args.path);
      const policy = policyOfDir(p, memo);
      const hidden = { n: 0 };
      const body = dirTree(p, memo, policy, 0, hidden);
      const foot = hidden.n ? `\n\n(${hidden.n} trash director${hidden.n === 1 ? 'y' : 'ies'} omitted — reach one by its explicit path)` : '';
      return [{ type: 'text', text: `${P.describePolicy(policy, p)}\n\n${body}${foot}` }];
    }

    case 'move_file': {
      const src = resolveSafe(args.source);
      const dst = resolveSafe(args.destination);
      assertNotMarker(src, 'moved');
      assertNotMarker(dst, 'created');
      const st = fs.lstatSync(src);

      const srcDir = path.dirname(src);
      const srcPolicy = policyOfDir(srcDir, memo);
      if (srcPolicy.error) throw new Error(`Refused — ${srcPolicy.error}`);
      if (srcPolicy.readonly)
        throw new Error(`Refused — ${srcDir} is read-only by policy (${P.describePolicy(srcPolicy, srcDir)}); nothing may leave it.`);

      const dstPolicy = guardWrite(dst, memo, 'written');

      // Discarding goes through trash_file, which stamps the name and keeps the
      // relative path. A hand-rolled move into the trash would produce a file
      // that the sweeper can never age out.
      const dstTrash = P.trashDirOf(dstPolicy);
      if (dstTrash && P.inside(dst, dstTrash))
        throw new Error(`Refused — do not move things into the trash by hand; use trash_file, which stamps the arrival time and preserves the relative path.`);

      if (st.isDirectory()) {
        if (srcPolicy.overwrite !== 'free')
          throw new Error(`Refused — a directory cannot be taken out of a zone with policy "overwrite: ${srcPolicy.overwrite}": a directory has no content and therefore no rev to check. Move its files individually.`);
      } else {
        guardTakeOut(src, srcPolicy, args.rev, 'moved');
      }

      if (fs.existsSync(dst)) {
        if (dstPolicy.overwrite !== 'free')
          throw new Error(`Refused — ${dst} already exists and the destination zone has policy "overwrite: ${dstPolicy.overwrite}". Discard the destination first (trash_file), then move.`);
        if (st.isDirectory())
          throw new Error(`Refused — ${dst} already exists; a directory is not moved onto an existing path.`);
      }

      fs.renameSync(src, dst);
      return [{ type: 'text', text: `Moved: ${src} → ${dst}` }];
    }

    case 'trash_file': {
      const p = resolveSafe(args.path);
      assertNotMarker(p, 'discarded');
      const st = fs.lstatSync(p);
      if (st.isDirectory())
        throw new Error(`${p} is a directory. Directories are not discarded as a unit — trash the files inside it one by one, then the empty directory can be moved if its zone allows it.`);
      if (!st.isFile()) throw new Error(`${p} is not a regular file.`);

      const dir = path.dirname(p);
      const policy = policyOfDir(dir, memo);
      if (policy.error) throw new Error(`Refused — ${policy.error}`);
      if (policy.readonly)
        throw new Error(`Refused — ${dir} is read-only by policy; a trash in a read-only zone would be meaningless and is ignored. Nothing was moved.`);

      const trashDir = P.trashDirOf(policy);
      if (!trashDir)
        throw new Error(`Refused — no trash is configured for this zone (${P.describePolicy(policy, dir)}), so nothing can be discarded here. Turn the trash on for the zone on the add-on's "Vault policies" page.`);
      if (P.inside(p, trashDir)) throw new Error(`${p} is already in the trash.`);

      guardTakeOut(p, policy, args.rev, 'discarded');

      // Relative to the directory that OWNS the trash, so wiki/system/foo.md
      // lands at wiki/.vault-trash/system/foo.md and stays identifiable.
      const rel = path.relative(policy.trashOwner, p);
      const stamp = P.stampNow();
      let dest = path.join(trashDir, path.dirname(rel), P.stampName(path.basename(p), stamp));
      for (let i = 1; fs.existsSync(dest); i++) {
        dest = path.join(trashDir, path.dirname(rel), P.stampName(path.basename(p), `${stamp}-${i}`));
        if (i > 50) throw new Error('cannot find a free name in the trash');
      }
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.renameSync(p, dest);
      return [{ type: 'text', text:
        `Discarded: ${p}\n→ ${dest}\n` +
        `Nothing was deleted — the file sits in the trash and is excluded from grep_files, search_files, directory_tree and read_multiple_files.` +
        (policy.retention_enabled ? ` Auto-purge is ON for this zone: it will be erased ${policy.retention_days} days after the timestamp in the name.` : '') }];
    }

    case 'search_files': {
      const base = resolveSafe(args.path);
      const exclude = coerceArray(args.excludePatterns || [], 'excludePatterns');
      const results = [];
      let hiddenTrash = 0;
      function walk(dir, policy) {
        const trash = P.trashDirOf(policy);
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          if (exclude.some(ex => e.name.includes(ex))) continue;
          const full = path.join(dir, e.name);
          if (e.isDirectory() && trash && full === trash) { hiddenTrash++; continue; }
          if (e.name.includes(args.pattern) || full.includes(args.pattern)) results.push(full);
          if (e.isDirectory()) walk(full, P.applyMarker(policy, full, memo));
        }
      }
      walk(base, policyOfDir(base, memo));
      const foot = hiddenTrash ? `\n\n(${hiddenTrash} trash director${hiddenTrash === 1 ? 'y' : 'ies'} not searched)` : '';
      return [{ type: 'text', text: (results.join('\n') || 'No matches') + foot }];
    }

    case 'get_file_info': {
      const p = resolveSafe(args.path);
      const s = fs.statSync(p);
      const info = { path: p, size: s.size, isFile: s.isFile(), isDirectory: s.isDirectory(), created: s.birthtime, modified: s.mtime };
      // lines/rev only for text files small enough to hash cheaply; a binary or
      // a huge blob just gets the old field set.
      if (s.isFile() && s.size <= GREP_MAX_FILE) {
        try {
          const buf = fs.readFileSync(p);
          if (!buf.subarray(0, 4096).includes(0)) {
            const text = buf.toString('utf8');
            info.lines = splitLines(stripBom(text)).lines.length;
            info.rev = revOf(text);
          }
        } catch {}
      }
      return [{ type: 'text', text: JSON.stringify(info, null, 2) }];
    }

    case 'list_allowed_directories':
      return [{ type: 'text', text: `Allowed directories:\n${ALLOWED_DIR}` }];

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

async function handleMcpRequest(body) {
  const { id, method, params } = body;

  if (method === 'initialize') {
    return { jsonrpc: '2.0', id, result: {
      protocolVersion: '2024-11-05',
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'vault-mcp-server', version: VERSION }
    }};
  }

  if (method === 'notifications/initialized' || method === 'notifications/roots/list_changed') return null;
  if (method === 'ping') return { jsonrpc: '2.0', id, result: {} };
  if (method === 'tools/list') return { jsonrpc: '2.0', id, result: { tools: TOOLS } };
  if (method === 'resources/list') return { jsonrpc: '2.0', id, result: { resources: [] } };
  if (method === 'prompts/list') return { jsonrpc: '2.0', id, result: { prompts: [] } };
  if (method === 'roots/list') return { jsonrpc: '2.0', id, result: { roots: [{ uri: `file://${ALLOWED_DIR}`, name: 'VAULT' }] } };

  if (method === 'tools/call') {
    try {
      const content = await callTool(params.name, params.arguments || {});
      // Issue #3: no structuredContent — tools declare no outputSchema, and
      // duplicating content into it doubled the payload for base64 media.
      return { jsonrpc: '2.0', id, result: { content } };
    } catch (e) {
      return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true } };
    }
  }

  return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, DELETE');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept, mcp-session-id, mcp-protocol-version');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // POST /write was removed in 2.6.0. It wrote any file, with no rev check and
  // no token of its own, and the blind prefix proxy forwarded it straight from
  // the internet — one curl and every policy below is moot. Its only consumer
  // was a weekly snapshot that overwrote itself and kept no history.
  if (req.url !== '/mcp') { res.writeHead(404); res.end('Not found'); return; }

  // Issue #4: this server never sends server-initiated notifications, so per
  // the MCP Streamable HTTP spec we decline the GET SSE channel with 405
  // instead of holding a dead stream open (which hangs clients waiting on it
  // and starves buffering proxies like cloudflared of any bytes at all).
  if (req.method !== 'POST') { res.writeHead(405, { 'Allow': 'POST, OPTIONS' }); res.end(); return; }

  const accept = req.headers['accept'] || '';
  if (!accept.includes('application/json') && !accept.includes('text/event-stream')) {
    res.writeHead(406);
    res.end(JSON.stringify({ error: 'Not Acceptable: Client must accept both application/json and text/event-stream' }));
    return;
  }

  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', async () => {
    let body;
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { res.writeHead(400); res.end('Bad JSON'); return; }

    const requests = Array.isArray(body) ? body : [body];
    const responses = [];
    for (const r of requests) {
      const resp = await handleMcpRequest(r);
      if (resp !== null) responses.push(resp);
    }

    const result = Array.isArray(body) ? responses : (responses[0] || null);
    if (result === null) { res.writeHead(202); res.end(); return; }

    // Issue #4: plain JSON instead of a single-event SSE response. The spec
    // allows either ("the server MUST either return Content-Type:
    // text/event-stream ... or Content-Type: application/json"), and JSON is
    // immune to SSE buffering in tunnels (cloudflare/cloudflared#1449) that
    // may truncate large base64 payloads such as read_pdf_page images.
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
  });
});

if (GREP_WORKER) {
  // Forked child: do one grep job, answer, exit. Never binds a port.
  process.on('message', job => {
    let out;
    try { out = grepRun(job); }
    catch (e) { out = { error: e.message }; }
    try { process.send(out, () => process.exit(0)); }
    catch { process.exit(1); }
  });
  // Do not outlive a parent that went away.
  process.on('disconnect', () => process.exit(0));
} else {
  server.listen(PORT, () => {
    process.stderr.write(`Vault MCP Server v${VERSION} on port ${PORT}, allowed: ${ALLOWED_DIR}\n`);
  });
  // Trash sweep: off unless a zone opts in. Runs shortly after start and once
  // a day after that.
  require('./retention').start(ALLOWED_DIR);
}
