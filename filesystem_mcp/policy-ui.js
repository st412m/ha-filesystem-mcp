#!/usr/bin/env node
'use strict';
/**
 * Vault MCP — the "Vault policies" page (2.6.0)
 *
 * The ONLY channel that writes .vault-policy markers. It listens on its own
 * port (3101, ingress, not published in `ports:`) and runs its own
 * http.createServer — the MCP dispatcher on 3099 has no reference to the write
 * function below. That separation is the point: the 3100 proxy forwards a bare
 * path prefix, so anything reachable on 3099 is reachable from the internet
 * with the token, and a marker writer must not be.
 *
 * Per Home Assistant's add-on docs, ingress traffic arrives only from
 * 172.30.32.2; every other source is refused. The base URL is taken from the
 * X-Ingress-Path header the gateway adds.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const P = require('./policy');
const SP = require('./safepath');

const VERSION = process.env.ADDON_VERSION || '0.0.0-dev';
const PORT = parseInt(process.argv[3] || '3101', 10);
const SUPERVISOR_IP = '172.30.32.2';
// Local testing only (`ALLOW_LOCAL=true node policy-ui.js /tmp/vault`).
const ALLOW_LOCAL = process.env.ALLOW_LOCAL === 'true';

// Until 2.7.3 this file carried its own byte-for-byte copy of resolveSafe.
// Both copies now come from safepath.js; ROOT is the branded vault root, and
// anything that leaves this process as JSON takes `.path`.
const R = SP.createResolver(process.argv[2] || process.env.VAULT_PATH || '/media/VAULT');
const resolveSafe = R.resolveSafe;
const ROOT = R.root;

function fromSupervisor(req) {
  const ip = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  if (ip === SUPERVISOR_IP) return true;
  return ALLOW_LOCAL && (ip === '127.0.0.1' || ip === '::1');
}

// ---------------------------------------------------------------------------
// Marker writing — lives here and nowhere else
// ---------------------------------------------------------------------------

const PREAMBLE = 'Vault MCP policy. Applies to this directory and everything below it, ' +
  'until a deeper marker of the same name is met. Managed from the add-on page ' +
  '"Vault policies" — edit by hand only to repair it.';

function writeMarker(dir, spec) {
  const body = {
    _: PREAMBLE,
    readonly: spec.readonly,
    overwrite: spec.overwrite,
    trash: spec.trash,
    retention_enabled: spec.retention_enabled,
    retention_days: spec.retention_days,
  };
  // Validate the exact bytes that will land on disk, before anything is
  // written: a marker this page itself cannot parse would lock the zone.
  P.parseMarker(JSON.stringify(body));

  // Both destinations are re-checked rather than merely joined onto dir: this
  // is the only place in the add-on that writes a marker, and a directory that
  // turned into a symlink out of the vault between the tree scan and the save
  // would otherwise be written to.
  const target = resolveSafe(SP.child(dir, P.POLICY_FILE).path);
  const tmp = resolveSafe(SP.child(dir, `.vault-policy.tmp-${process.pid}-${Date.now()}`).path);
  const text = JSON.stringify(body, null, 2) + '\n';
  fs.writeFileSync(tmp.path, text, 'utf8');
  try { fs.renameSync(tmp.path, target.path); }
  catch (e) { try { fs.unlinkSync(tmp.path); } catch {} throw e; }
  return target.path;
}

// unlink never follows the final symlink, so a marker that is one gets removed
// rather than followed — the lexical path is enough here.
function removeMarker(dir) {
  const target = SP.child(dir, P.POLICY_FILE);
  try { fs.unlinkSync(target.path); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  return target.path;
}

// ---------------------------------------------------------------------------
// Tree: the root and what sits directly in it. One level, deliberately.
// ---------------------------------------------------------------------------

// Three outcomes, and the difference matters on the page. trashDirOf() is
// lexical — the name comes from a marker, not from a readdir — so a trash that
// is a symlink out of the vault would otherwise have someone else's directory
// counted and shown as this zone's. Anything that is not a directory, symlink
// included, therefore counts as unknown (null, rendered without a number),
// same as a trash this zone does not own; the sweep refuses such a trash on
// the same lstat. A trash that simply does not exist yet is not unknown: it is
// created by the first trash_file, and until then it holds nothing, so it
// counts 0 and the page keeps saying "trash (0)" as it did before 2.8.0.
function countTrash(trashDir) {
  let st;
  try { st = fs.lstatSync(trashDir.path); }
  catch (e) { return e.code === 'ENOENT' ? 0 : null; }
  if (!st.isDirectory()) return null;
  let n = 0;
  const walk = (d, depth) => {
    if (depth > 6) return;
    let entries;
    try { entries = fs.readdirSync(d.path, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.isDirectory()) walk(SP.child(d, e.name), depth + 1);
      else if (e.isFile()) n++;
    }
  };
  walk(trashDir, 0);
  return n;
}

function ownMarker(dir) {
  try { return fs.lstatSync(SP.child(dir, P.POLICY_FILE).path).isFile(); } catch { return false; }
}

function describeEntry(dir, memo) {
  const policy = P.policyForDir(dir, ROOT, memo);
  const own = ownMarker(dir);
  const trashDir = P.trashDirOf(policy);
  const out = {
    path: dir.path,
    name: path.basename(dir.path),
    own,
    error: policy.error,
    mode: own ? modeOf(policy) : 'inherit',
    effective: modeOf(policy),
    trash: !!policy.trash,
    trashName: policy.trash || P.DEFAULT_TRASH,
    trashOwn: trashDir ? policy.trashOwner.path === dir.path : false,
    trashCount: null,
    retention_enabled: !!policy.retention_enabled,
    retention_days: policy.retention_days || 30,
    source: policy.source,
    summary: P.describePolicy(policy, dir.path),
  };
  if (trashDir && out.trashOwn) out.trashCount = countTrash(trashDir);
  return out;
}

function modeOf(policy) {
  if (policy.readonly) return 'readonly';
  return policy.overwrite;   // 'rev' | 'never' | 'free'
}

function buildTree() {
  const memo = new Map();
  const root = describeEntry(ROOT, memo);
  const rootPolicy = P.policyForDir(ROOT, ROOT, memo);
  const rootTrash = P.trashDirOf(rootPolicy);
  const children = [];
  for (const e of fs.readdirSync(ROOT.path, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    if (P.SKIP_DIRS.has(e.name)) continue;
    const full = SP.child(ROOT, e.name);
    if (rootTrash && full.path === rootTrash.path) continue;   // the trash is not a zone to configure
    children.push(describeEntry(full, memo));
  }
  children.sort((a, b) => a.name.localeCompare(b.name));

  // Markers placed deeper than one level are not created here, but they must be
  // visible — somebody will drop one in by hand, and an invisible rule is worse
  // than a strict one. Directories only, bounded, no file walking.
  // Keyed by string: scan.dirs holds brands, and two brands for the same
  // directory are different objects.
  const scan = P.findMarkerDirs(ROOT, memo);
  const shallow = new Set([ROOT.path, ...children.map(c => c.path)]);
  const deeper = scan.dirs.filter(d => !shallow.has(d.path)).map(d => {
    const pol = P.policyForDir(d, ROOT, memo);
    return { path: d.path, summary: P.describePolicy(pol, d.path), error: pol.error };
  });

  return { root, children, deeper, truncated: scan.truncated, vault: ROOT.path, version: VERSION };
}

// ---------------------------------------------------------------------------
// Save
// ---------------------------------------------------------------------------

function applyChange(body) {
  if (!body || typeof body.path !== 'string') throw new Error('path is required');
  const dir = resolveSafe(body.path);
  let st;
  try { st = fs.lstatSync(dir.path); } catch { throw new Error(`${dir.path} does not exist`); }
  if (!st.isDirectory()) throw new Error(`${dir.path} is not a directory`);

  if (body.mode === 'inherit') {
    const t = removeMarker(dir);
    return `Marker removed: ${t} — this directory now follows the rule above it.`;
  }

  const spec = {
    readonly: body.mode === 'readonly',
    overwrite: body.mode === 'readonly' ? 'never' : body.mode,
    trash: body.trash ? P.validTrashName(body.trashName || P.DEFAULT_TRASH) : null,
    retention_enabled: !!body.retention_enabled,
    retention_days: parseInt(body.retention_days, 10),
  };
  if (!Number.isInteger(spec.retention_days)) spec.retention_days = 30;
  if (!['rev', 'never', 'free'].includes(spec.overwrite))
    throw new Error(`unknown mode "${body.mode}"`);
  if (spec.readonly && spec.trash) spec.trash = null;   // meaningless, dropped

  const t = writeMarker(dir, spec);
  return `Saved: ${t}`;
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

function json(res, code, obj) {
  const b = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': b.length });
  res.end(b);
}

const server = http.createServer((req, res) => {
  if (!fromSupervisor(req)) { res.writeHead(403, { 'Content-Type': 'text/plain' }); res.end('Forbidden\n'); return; }

  const url = req.url.split('?')[0].replace(/\/+$/, '') || '/';

  if (req.method === 'GET' && (url === '/' || url === '/index.html')) {
    const base = (req.headers['x-ingress-path'] || '').replace(/\/+$/, '');
    const body = Buffer.from(page(base), 'utf8');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': body.length });
    res.end(body);
    return;
  }

  if (req.method === 'GET' && url === '/api/tree') {
    try { json(res, 200, buildTree()); }
    catch (e) { json(res, 500, { error: e.message }); }
    return;
  }

  if (req.method === 'POST' && url === '/api/policy') {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const msg = applyChange(body);
        json(res, 200, { ok: true, message: msg });
      } catch (e) {
        json(res, 400, { ok: false, error: e.message });
      }
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found\n');
});

server.listen(PORT, () => {
  process.stderr.write(`Vault policy page v${VERSION} on port ${PORT} (ingress), vault: ${ROOT.path}\n`);
});

// ---------------------------------------------------------------------------
// The page itself
// ---------------------------------------------------------------------------

function page(base) {
  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Vault policies</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: -apple-system, "Segoe UI", Roboto, sans-serif; margin: 0; padding: 24px;
         background: var(--primary-background-color, #fafafa); color: var(--primary-text-color, #212121); }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .sub { color: #888; font-size: 13px; margin-bottom: 20px; }
  table { border-collapse: collapse; width: 100%; max-width: 900px; }
  td { padding: 10px 8px; border-bottom: 1px solid rgba(127,127,127,.25); vertical-align: middle; }
  td.name { font-family: ui-monospace, "SF Mono", Menlo, monospace; white-space: nowrap; }
  .root td.name { font-weight: 600; }
  .hint { color: #888; font-size: 12px; }
  select, input[type=number] { padding: 5px; font: inherit; }
  input[type=number] { width: 64px; }
  label.chk { margin-right: 14px; font-size: 13px; white-space: nowrap; }
  .opts { display: flex; align-items: center; flex-wrap: wrap; gap: 4px; }
  .err { color: #c62828; font-size: 13px; }
  .deeper { max-width: 900px; margin-top: 28px; font-size: 13px; }
  .deeper div.row { padding: 8px 0; border-bottom: 1px solid rgba(127,127,127,.25); display: flex;
                    justify-content: space-between; gap: 12px; align-items: center; }
  button { font: inherit; padding: 5px 10px; cursor: pointer; }
  #msg { position: sticky; bottom: 0; padding: 10px 0; font-size: 13px; }
  .note { max-width: 900px; margin-top: 28px; font-size: 13px; color: #888; line-height: 1.5; }
</style>
</head><body>
<h1>Vault policies</h1>
<div class="sub" id="sub">loading…</div>
<table id="tbl"></table>
<div class="deeper" id="deeper"></div>
<div class="note">
  A policy applies to its directory and everything below it, until a deeper marker overrides it.
  Put policies on the top-level directories and let the rest inherit; if some nested directory needs
  its own rule, it is usually cleaner to lift that directory up here.
  <br><br>
  <b>Read-only</b> stops this add-on's tools. It does not stop anything else that writes to the vault
  — a Home Assistant <code>shell_command</code> copying files in, Samba, the file editor — those go
  straight to the filesystem and never see these markers.
</div>
<div id="msg"></div>
<script>
const BASE = ${JSON.stringify(base)};
const MODES = [["inherit","inherits"],["readonly","read-only"],["rev","edits with rev"],["free","free writes"],["never","new files only"]];
let DATA = null;

function el(t, a, kids) {
  const n = document.createElement(t);
  for (const k in (a||{})) { if (k === "class") n.className = a[k]; else if (k.startsWith("on")) n[k] = a[k]; else n.setAttribute(k, a[k]); }
  for (const c of (kids||[])) n.append(c);
  return n;
}

async function load() {
  const r = await fetch(BASE + "/api/tree");
  DATA = await r.json();
  if (DATA.error) { document.getElementById("sub").textContent = DATA.error; return; }
  document.getElementById("sub").textContent = DATA.vault + " · add-on " + DATA.version;
  render();
}

function row(e, isRoot) {
  const modes = isRoot ? MODES.filter(m => m[0] !== "inherit") : MODES;
  const sel = el("select");
  for (const [v, t] of modes) {
    const o = el("option", { value: v }); o.textContent = t;
    if (v === e.mode) o.selected = true;
    sel.append(o);
  }
  sel.onchange = () => save(e, { mode: sel.value });

  const opts = el("div", { class: "opts" });
  if (e.mode !== "inherit" && e.mode !== "readonly") {
    const cb = el("input", { type: "checkbox" });
    cb.checked = e.trash;
    cb.onchange = () => save(e, { trash: cb.checked });
    const lab = el("label", { class: "chk" }, [cb, document.createTextNode(
      " trash" + (e.trashCount !== null ? " (" + e.trashCount + ")" : ""))]);
    opts.append(lab);

    if (e.trash) {
      const rc = el("input", { type: "checkbox" });
      rc.checked = e.retention_enabled;
      rc.onchange = () => save(e, { retention_enabled: rc.checked });
      opts.append(el("label", { class: "chk" }, [rc, document.createTextNode(" auto-purge")]));
      const days = el("input", { type: "number", min: "1", max: "3650", value: String(e.retention_days) });
      days.onchange = () => save(e, { retention_days: parseInt(days.value, 10) });
      opts.append(days);
      opts.append(el("span", { class: "hint" }, [document.createTextNode(" days")]));
    }
  }

  const right = e.error
    ? el("div", { class: "err" }, [document.createTextNode(e.error)])
    : el("div", { class: "hint" }, [document.createTextNode(
        e.mode === "inherit" ? ("← " + (e.source ? e.source : "no marker above — unrestricted")) : "")]);

  return el("tr", { class: isRoot ? "root" : "" }, [
    el("td", { class: "name" }, [document.createTextNode(isRoot ? e.name + "/" : "└ " + e.name + "/")]),
    el("td", {}, [sel]),
    el("td", {}, [opts]),
    el("td", {}, [right]),
  ]);
}

function render() {
  const t = document.getElementById("tbl");
  t.textContent = "";
  t.append(row(DATA.root, true));
  for (const c of DATA.children) t.append(row(c, false));

  const d = document.getElementById("deeper");
  d.textContent = "";
  if (DATA.deeper.length) {
    d.append(el("b", {}, [document.createTextNode("Markers placed deeper than one level")]));
    for (const x of DATA.deeper) {
      const btn = el("button", { onclick: () => save({ path: x.path }, { mode: "inherit" }) });
      btn.textContent = "remove";
      d.append(el("div", { class: "row" }, [
        el("span", {}, [document.createTextNode(x.path + " — " + x.summary)]), btn
      ]));
    }
  }
  if (DATA.truncated) d.append(el("div", { class: "hint" }, [document.createTextNode(
    "The scan for deeper markers hit its limit; some may not be listed.")]));
}

async function save(entry, change) {
  const cur = DATA.children.concat([DATA.root]).find(x => x.path === entry.path) || entry;
  const body = {
    path: entry.path,
    mode: change.mode !== undefined ? change.mode : (cur.mode === "inherit" ? cur.effective : cur.mode),
    trash: change.trash !== undefined ? change.trash : !!cur.trash,
    trashName: cur.trashName,
    retention_enabled: change.retention_enabled !== undefined ? change.retention_enabled : !!cur.retention_enabled,
    retention_days: change.retention_days !== undefined ? change.retention_days : cur.retention_days,
  };
  const msg = document.getElementById("msg");
  try {
    const r = await fetch(BASE + "/api/policy", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
    });
    const j = await r.json();
    msg.textContent = j.ok ? j.message : ("Error: " + j.error);
    msg.className = j.ok ? "hint" : "err";
  } catch (e) {
    msg.textContent = "Error: " + e.message; msg.className = "err";
  }
  await load();
}

load();
</script>
</body></html>`;
}
