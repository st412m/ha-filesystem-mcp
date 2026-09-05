'use strict';
/**
 * Vault MCP — file-system policies (2.6.0)
 *
 * A policy marker is a JSON file named `.vault-policy` placed in a directory.
 * It applies to that directory and everything below it until a deeper marker
 * is met. Fields not named in the deeper marker keep the value inherited from
 * above, so a hand-written `{"readonly": true}` does not silently drop the
 * trash configured higher up.
 *
 * This module is shared by server.js (reads and enforces) and retention.js
 * (sweeps the trash). Writing a marker lives ONLY in policy-ui.js — the MCP
 * dispatcher has no reference to it.
 */

const fs = require('fs');
const path = require('path');

const POLICY_FILE = '.vault-policy';
const OVERWRITE_MODES = ['rev', 'never', 'free'];
const KNOWN_FIELDS = new Set(['_', 'readonly', 'overwrite', 'trash', 'retention_enabled', 'retention_days']);

const DEFAULT_TRASH = '.vault-trash';
const NOT_A_FILE = Symbol('not-a-file');
const SKIP_DIRS = new Set(['.git', 'node_modules', '.svn', '.hg']);

// No markers anywhere = 2.5.x behaviour, unchanged.
function unrestricted() {
  return {
    readonly: false,
    overwrite: 'free',
    trash: null,
    trashOwner: null,
    retention_enabled: false,
    retention_days: 30,
    source: null,      // directory of the deepest marker that shaped this policy
    error: null,
  };
}

// A corrupt or unknown-field marker fails CLOSED: nothing may be written,
// nothing may be deleted, reading still works. Deliberately no fallback to the
// parent policy — quietly running under someone else's rule is worse than a
// legible stop.
function failClosed(error) {
  return {
    readonly: true,
    overwrite: 'never',
    trash: null,
    trashOwner: null,
    retention_enabled: false,
    retention_days: 30,
    source: null,
    error,
  };
}

function parseMarker(text) {
  let obj;
  try { obj = JSON.parse(text); }
  catch (e) { throw new Error(`invalid JSON — ${e.message}`); }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('must be a JSON object');

  for (const k of Object.keys(obj)) {
    if (!KNOWN_FIELDS.has(k)) throw new Error(`unknown field "${k}" (known: ${[...KNOWN_FIELDS].join(', ')})`);
  }

  const out = {};
  if ('readonly' in obj) {
    if (typeof obj.readonly !== 'boolean') throw new Error('"readonly" must be true or false');
    out.readonly = obj.readonly;
  }
  if ('overwrite' in obj) {
    if (!OVERWRITE_MODES.includes(obj.overwrite)) throw new Error(`"overwrite" must be one of ${OVERWRITE_MODES.map(m => `"${m}"`).join(', ')}`);
    out.overwrite = obj.overwrite;
  }
  if ('trash' in obj) {
    if (obj.trash === null || obj.trash === '') out.trash = null;
    else out.trash = validTrashName(obj.trash);
  }
  if ('retention_enabled' in obj) {
    if (typeof obj.retention_enabled !== 'boolean') throw new Error('"retention_enabled" must be true or false');
    out.retention_enabled = obj.retention_enabled;
  }
  if ('retention_days' in obj) {
    const n = obj.retention_days;
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > 3650)
      throw new Error('"retention_days" must be a whole number of days between 1 and 3650');
    out.retention_days = n;
  }
  return out;
}

// One path segment, nothing else: a trash name with a separator or `..` would
// let a marker aim deletions at an arbitrary directory.
function validTrashName(name) {
  if (typeof name !== 'string') throw new Error('"trash" must be a string (a single directory name) or null');
  if (!name) throw new Error('"trash" must not be empty — use null to disable the trash');
  if (name.includes('/') || name.includes('\\')) throw new Error('"trash" must be a single directory name, without path separators');
  if (name === '.' || name === '..') throw new Error('"trash" must not be "." or ".."');
  if (name === POLICY_FILE) throw new Error(`"trash" must not be "${POLICY_FILE}"`);
  if (name !== path.basename(name)) throw new Error('"trash" must be a single directory name');
  return name;
}

// Reads (and memoises) one marker, returning the policy in effect *inside* dir.
// memo is a per-call Map: grep_files, directory_tree and the retention sweep
// each touch hundreds of paths, and without it this would be O(N × depth)
// reads. It is dropped when the call ends, so there is never a stale cache.
function applyMarker(parent, dir, memo) {
  const file = path.join(dir, POLICY_FILE);
  let text;
  if (memo && memo.has(file)) {
    text = memo.get(file);
  } else {
    try {
      // lstat, not stat: a symlink named .vault-policy must not be followed.
      text = fs.lstatSync(file).isFile() ? fs.readFileSync(file, 'utf8') : NOT_A_FILE;
    } catch { text = null; }
    if (memo) memo.set(file, text);
  }
  if (text === null) return parent;
  if (text === NOT_A_FILE) return failClosed(`${file} exists but is not a regular file — a directory or a symlink named ${POLICY_FILE} makes the zone unreadable. Remove it over Samba or with the file editor.`);
  if (parent.error) return parent;   // already failed closed higher up

  let m;
  try { m = parseMarker(text); }
  catch (e) {
    return failClosed(`${file}: ${e.message}. The zone is locked (read-only, no deletion) until the file is fixed — edit it from the add-on's "Vault policies" page, or repair it over Samba.`);
  }

  const next = Object.assign({}, parent);
  if ('readonly' in m) next.readonly = m.readonly;
  if ('overwrite' in m) next.overwrite = m.overwrite;
  if ('trash' in m) { next.trash = m.trash; next.trashOwner = m.trash ? dir : null; }
  if ('retention_enabled' in m) next.retention_enabled = m.retention_enabled;
  if ('retention_days' in m) next.retention_days = m.retention_days;
  next.source = dir;
  return next;
}

// Effective policy for a directory: root marker first, then every marker on the
// way down. `dir` must already have passed containment (resolveSafe).
function policyForDir(dir, root, memo) {
  const rel = path.relative(root, dir);
  const segs = (rel === '' || rel === '.') ? [] : rel.split(path.sep).filter(Boolean);
  let cur = applyMarker(unrestricted(), root, memo);
  let p = root;
  for (const s of segs) {
    p = path.join(p, s);
    cur = applyMarker(cur, p, memo);
  }
  return cur;
}

// For a file, the policy of the directory holding it.
function policyForPath(p, root, memo, isDir) {
  return policyForDir(isDir ? p : path.dirname(p), root, memo);
}

function trashDirOf(policy) {
  return (policy.trash && policy.trashOwner) ? path.join(policy.trashOwner, policy.trash) : null;
}

function inside(p, root) {
  return p === root || p.startsWith(root + path.sep);
}

// ---------------------------------------------------------------------------
// Trash name stamping
// ---------------------------------------------------------------------------
// A move does not change mtime, so the age of a trashed file cannot be read
// from its metadata — a page that sat in the wiki for six months would be swept
// on the first pass. The stamp is the arrival time, in UTC (the container clock
// is UTC; the Z is explicit so nobody reads it as local time). It doubles as a
// collision breaker: two files of the same name coexist.

const STAMP_RE = /__trash-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z(?:-\d+)?/;

function stampNow(d) {
  d = d || new Date();
  const p2 = n => String(n).padStart(2, '0');
  return `__trash-${d.getUTCFullYear()}${p2(d.getUTCMonth() + 1)}${p2(d.getUTCDate())}T` +
         `${p2(d.getUTCHours())}${p2(d.getUTCMinutes())}${p2(d.getUTCSeconds())}Z`;
}

function stampName(name, stamp) {
  const ext = path.extname(name);
  const base = ext ? name.slice(0, -ext.length) : name;
  return `${base}${stamp}${ext}`;
}

// null = no stamp in the name → put there by hand over Samba → never ours to
// delete.
function stampOf(name) {
  const m = STAMP_RE.exec(name);
  if (!m) return null;
  const t = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  return Number.isFinite(t) ? new Date(t) : null;
}

// ---------------------------------------------------------------------------
// Human-readable policy line, printed by the listing tools
// ---------------------------------------------------------------------------
function describePolicy(policy, dir) {
  if (policy.error) return `⚠ Policy: BROKEN MARKER — zone locked (read-only, no deletion). ${policy.error}`;
  if (!policy.source) return 'Policy: none — unrestricted (no .vault-policy marker above this directory).';

  const bits = [];
  bits.push(policy.readonly ? 'read-only' : `overwrite=${policy.overwrite}`);
  if (policy.trash) {
    const own = policy.trashOwner === dir ? '' : ` in ${policy.trashOwner}`;
    bits.push(`trash=${policy.trash}${own}`);
  } else {
    bits.push('no trash (deletion not available)');
  }
  if (policy.retention_enabled && policy.trash) bits.push(`auto-purge after ${policy.retention_days} d`);
  const origin = policy.source === dir
    ? `own marker (${path.join(policy.source, POLICY_FILE)})`
    : `inherited from ${path.join(policy.source, POLICY_FILE)}`;
  return `Policy: ${bits.join(', ')} — ${origin}`;
}

// ---------------------------------------------------------------------------
// Zone discovery — used by retention and by the policy page
// ---------------------------------------------------------------------------
// Directories only, bounded, never descends into a trash or into .git /
// node_modules, and never follows a symlink.
function findMarkerDirs(root, memo, opts) {
  const o = Object.assign({ maxDepth: 8, maxDirs: 5000 }, opts || {});
  const found = [];
  let visited = 0;
  let truncated = false;

  const walk = (dir, policy, depth) => {
    if (truncated) return;
    if (visited++ > o.maxDirs) { truncated = true; return; }
    if (fs.existsSync(path.join(dir, POLICY_FILE))) found.push(dir);
    if (depth >= o.maxDepth) return;
    const trash = trashDirOf(policy);
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;          // isDirectory() is false for symlinks
      if (SKIP_DIRS.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (trash && full === trash) continue;
      walk(full, applyMarker(policy, full, memo), depth + 1);
    }
  };

  walk(root, applyMarker(unrestricted(), root, memo), 0);
  return { dirs: found, truncated };
}

module.exports = {
  POLICY_FILE, OVERWRITE_MODES, DEFAULT_TRASH, SKIP_DIRS,
  unrestricted, failClosed, parseMarker, validTrashName,
  applyMarker, policyForDir, policyForPath, trashDirOf, inside,
  stampNow, stampName, stampOf, describePolicy, findMarkerDirs,
};
