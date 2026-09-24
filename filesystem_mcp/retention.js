'use strict';
/**
 * Vault MCP — trash retention sweep (2.6.0)
 *
 * Off by default. A zone opts in with `retention_enabled: true` on the marker
 * that also defines its trash.
 *
 * Deliberate limits, all of them load-bearing:
 *  - no recursive delete anywhere; files are removed one by one, directories
 *    only by rmdir, which refuses a non-empty one. With no recursion there is
 *    also no way to walk out of the vault along a symlink.
 *  - a file whose name carries no arrival stamp was put there by hand (Samba)
 *    and is never touched.
 *  - only paths physically inside a trash directory allowed by the policy in
 *    force are considered.
 *
 * Context for anyone tempted to switch this on by default: the vault backup is
 * a mirror without history (rsync --delete, no --backup-dir). What is erased
 * here disappears from the NAS at the next run.
 */

const fs = require('fs');
const P = require('./policy');
const SP = require('./safepath');

const DAY_MS = 24 * 60 * 60 * 1000;

function log(msg) {
  process.stderr.write(`[retention] ${msg}\n`);
}

function sweepTrash(trashDir, days, root) {
  const trashPath = SP.pathOf(trashDir, 'sweepTrash');
  const rootPath = SP.pathOf(root, 'sweepTrash');
  const cutoff = Date.now() - days * DAY_MS;
  let removed = 0, bytes = 0, kept = 0, unstamped = 0;

  // Collect directories on the way down, then rmdir them bottom-up.
  const dirs = [];

  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir.path, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = SP.child(dir, e.name);
      if (!P.inside(full.path, trashPath) || !P.inside(full.path, rootPath)) continue;
      let st;
      try { st = fs.lstatSync(full.path); } catch { continue; }
      if (st.isDirectory()) { dirs.push(full); walk(full); continue; }
      if (!st.isFile()) continue;              // symlinks, sockets, devices — not ours
      const stamp = P.stampOf(e.name);
      if (!stamp) { unstamped++; continue; }
      if (stamp.getTime() > cutoff) { kept++; continue; }
      const ageDays = ((Date.now() - stamp.getTime()) / DAY_MS).toFixed(1);
      try {
        fs.unlinkSync(full.path);
        removed++; bytes += st.size;
        log(`removed ${full.path} · ${ageDays} d old · ${st.size} B`);
      } catch (err) {
        log(`FAILED to remove ${full.path}: ${err.message}`);
      }
    }
  };

  walk(trashDir);

  // Bottom-up so a directory emptied by this pass can go too. rmdir refuses a
  // non-empty directory by itself — that is the whole guard.
  let dirsRemoved = 0;
  for (const d of dirs.sort((a, b) => b.path.length - a.path.length)) {
    try { fs.rmdirSync(d.path); dirsRemoved++; } catch {}
  }

  return { removed, bytes, kept, unstamped, dirsRemoved };
}

function runSweep(root) {
  SP.pathOf(root, 'runSweep');
  const memo = new Map();
  let zones;
  try { zones = P.findMarkerDirs(root, memo); }
  catch (e) { log(`scan failed: ${e.message}`); return; }
  if (zones.truncated) log('marker scan hit its limit — some deep zones were not visited');

  // Keyed by string: two brands for the same directory are different objects.
  const seen = new Set();
  let active = 0;

  for (const dir of zones.dirs) {
    const policy = P.policyForDir(dir, root, memo);
    if (policy.error) { log(`skipping ${dir.path} — ${policy.error}`); continue; }
    if (!policy.retention_enabled) continue;
    const trashDir = P.trashDirOf(policy);
    if (!trashDir) continue;
    // Only the zone that OWNS the trash sweeps it. Otherwise a child that
    // merely inherited the trash could order a purge of its parent's. Compared
    // by string — the brands are never the same object.
    if (policy.trashOwner.path !== dir.path) continue;
    if (seen.has(trashDir.path)) continue;
    seen.add(trashDir.path);
    if (policy.readonly) { log(`skipping ${trashDir.path} — zone is read-only, trash is meaningless there`); continue; }
    let st;
    try { st = fs.lstatSync(trashDir.path); } catch { continue; }
    if (!st.isDirectory()) { log(`skipping ${trashDir.path} — not a directory`); continue; }

    active++;
    const r = sweepTrash(trashDir, policy.retention_days, root);
    log(`${trashDir.path}: removed ${r.removed} file(s), ${(r.bytes / 1024).toFixed(1)} KB, ` +
        `${r.dirsRemoved} empty dir(s); kept ${r.kept} newer than ${policy.retention_days} d` +
        (r.unstamped ? `, left ${r.unstamped} unstamped file(s) alone` : ''));
  }

  if (!active) log('no zone has auto-purge enabled — nothing to do');
}

// At start, then once a day. unref() so the timer never holds the process up.
function start(root) {
  SP.pathOf(root, 'start');
  const tick = () => { try { runSweep(root); } catch (e) { log(`sweep crashed: ${e.message}`); } };
  setTimeout(tick, 5000).unref();
  setInterval(tick, DAY_MS).unref();
}

module.exports = { start, runSweep, sweepTrash };
