'use strict';
/**
 * Vault MCP — file-system policies
 *
 * A policy marker is a JSON file named `.vault-policy` placed in a directory.
 * It applies to that directory and everything below it until a deeper marker
 * is met. Fields not named in the deeper marker keep the value inherited from
 * above: a marker with only `{"readonly": true}` keeps the trash configured
 * higher up.
 *
 * Used by server.js (reads and enforces) and retention.js (sweeps the trash).
 * Markers are written only by policy-ui.js; the MCP dispatcher has no
 * reference to that code.
 */

const fs = require('fs');
const path = require('path');
const SP = require('./safepath');

const POLICY_FILE = '.vault-policy';
const OVERWRITE_MODES = ['rev', 'never', 'free'];
const KNOWN_FIELDS = new Set(['_', 'readonly', 'overwrite', 'trash', 'retention_enabled', 'retention_days']);

const DEFAULT_TRASH = '.vault-trash';
const NOT_A_FILE = Symbol('not-a-file');
const SKIP_DIRS = new Set(['.git', 'node_modules', '.svn', '.hg']);

// No markers anywhere: no restrictions.
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

// A corrupt or unknown-field marker fails closed: nothing may be written or
// deleted, reading still works. There is no fallback to the parent policy.
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

// Reads (and memoises) one marker, returning the policy in effect inside dir.
// memo is a per-call Map, so a walk reads each marker once.
function applyMarker(parent, dir, memo) {
  const dirPath = SP.pathOf(dir, 'applyMarker');
  // The marker is a child of a checked path. memo is keyed by the string: each
  // brand is a new object.
  const file = SP.child(dir, POLICY_FILE).path;
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
  // trashOwner is a brand: retention.js unlinks inside the trash built from it.
  // source is only printed or compared, so it is a plain string.
  next.source = dirPath;
  return next;
}

// Effective policy for a directory: root marker first, then every marker on the
// way down. The steps are built with child(), which refuses a `..` segment, so a
// dir that is not under root fails instead of reading markers outside it.
//
// The chain is built along the directory's real place (SP.canonical), so a
// directory reached through a symlink gets the policy of where it really is.
// `real` is that place as a brand; trashOwner and source in the policy are in
// the same coordinates.
function policyAt(dir, root, memo) {
  SP.pathOf(dir, 'policyAt');
  const rootPath = SP.pathOf(root, 'policyAt');
  const real = SP.canonical(dir);
  const rel = path.relative(rootPath, real.path);
  const segs = (rel === '' || rel === '.') ? [] : rel.split(path.sep).filter(Boolean);
  let cur = applyMarker(unrestricted(), root, memo);
  let p = root;
  for (const s of segs) {
    p = SP.child(p, s);
    cur = applyMarker(cur, p, memo);
  }
  return { policy: cur, real };
}

function policyForDir(dir, root, memo) {
  SP.pathOf(dir, 'policyForDir');
  return policyAt(dir, root, memo).policy;
}

// For a file, the policy of the directory holding it. Going up is a full
// resolveSafe (see safepath.parent), not a lexical dirname.
function policyForPath(p, root, memo, isDir) {
  SP.pathOf(p, 'policyForPath');
  return policyForDir(isDir ? p : SP.parent(p), root, memo);
}

// A brand: retention.js reads and unlinks inside this directory. The name is
// one segment (validTrashName), so child() builds it. It is lexical: a trash
// directory that is a symlink out of the vault is not caught here, so anything
// that writes into it resolveSafe()s the destination first (see trash_file).
function trashDirOf(policy) {
  return (policy.trash && policy.trashOwner) ? SP.child(policy.trashOwner, policy.trash) : null;
}

// Re-exported from safepath; policy-ui.js uses it as P.inside. Takes strings.
const inside = SP.inside;

// ---------------------------------------------------------------------------
// Trash name stamping
// ---------------------------------------------------------------------------
// A move does not change mtime, so the age of a trashed file is the arrival
// time stamped into its name, in UTC with an explicit Z. The stamp also lets
// two files of the same name coexist.

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

// null = no stamp in the name: the file was put there by hand and is never
// deleted.
function stampOf(name) {
  const m = STAMP_RE.exec(name);
  if (!m) return null;
  const t = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  return Number.isFinite(t) ? new Date(t) : null;
}

// ---------------------------------------------------------------------------
// Human-readable policy line, printed by the listing tools
// ---------------------------------------------------------------------------
// Display only, no disk access: `dir` is a plain string (callers pass `.path`).
// `real` is the directory's real place (policyAt().real.path); when it differs
// from `dir`, the line ends with where the path resolves to.
function describePolicy(policy, dir, real) {
  const at = real || dir;
  const via = at === dir ? '' : ` (via symlink: resolves to ${at})`;
  if (policy.error) return `⚠ Policy: BROKEN MARKER — zone locked (read-only, no deletion). ${policy.error}${via}`;
  if (!policy.source) return `Policy: none — unrestricted (no .vault-policy marker above this directory).${via}`;

  const bits = [];
  bits.push(policy.readonly ? 'read-only' : `overwrite=${policy.overwrite}`);
  if (policy.trash) {
    const own = policy.trashOwner.path === at ? '' : ` in ${policy.trashOwner.path}`;
    bits.push(`trash=${policy.trash}${own}`);
  } else {
    bits.push('no trash (deletion not available)');
  }
  if (policy.retention_enabled && policy.trash) bits.push(`auto-purge after ${policy.retention_days} d`);
  const origin = policy.source === at
    ? `own marker (${path.join(policy.source, POLICY_FILE)})`
    : `inherited from ${path.join(policy.source, POLICY_FILE)}`;
  return `Policy: ${bits.join(', ')} — ${origin}${via}`;
}

// ---------------------------------------------------------------------------
// Zone discovery — used by retention and by the policy page
// ---------------------------------------------------------------------------
// Directories only, bounded, never descends into a trash or into .git /
// node_modules, and never follows a symlink. `dirs` are brands built with
// child() from the checked root; callers pass them to policyForDir and print
// `.path`.
function findMarkerDirs(root, memo, opts) {
  SP.pathOf(root, 'findMarkerDirs');
  const o = Object.assign({ maxDepth: 8, maxDirs: 5000 }, opts || {});
  const found = [];
  let visited = 0;
  let truncated = false;

  const walk = (dir, policy, depth) => {
    if (truncated) return;
    if (visited++ > o.maxDirs) { truncated = true; return; }
    if (fs.existsSync(SP.child(dir, POLICY_FILE).path)) found.push(dir);
    if (depth >= o.maxDepth) return;
    const trash = trashDirOf(policy);
    let entries;
    try { entries = fs.readdirSync(dir.path, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;          // isDirectory() is false for symlinks
      if (SKIP_DIRS.has(e.name)) continue;
      const full = SP.child(dir, e.name);
      if (trash && full.path === trash.path) continue;
      walk(full, applyMarker(policy, full, memo), depth + 1);
    }
  };

  walk(root, applyMarker(unrestricted(), root, memo), 0);
  return { dirs: found, truncated };
}

module.exports = {
  POLICY_FILE, OVERWRITE_MODES, DEFAULT_TRASH, SKIP_DIRS,
  unrestricted, failClosed, parseMarker, validTrashName,
  applyMarker, policyAt, policyForDir, policyForPath, trashDirOf, inside,
  stampNow, stampName, stampOf, describePolicy, findMarkerDirs,
};
