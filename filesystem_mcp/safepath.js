'use strict';
/**
 * Vault MCP — the one place a path is checked against the vault (2.8.0)
 *
 * Until 2.7.3 resolveSafe() existed twice, byte for byte, in server.js and in
 * policy-ui.js, and the modules behind them (policy.js, retention.js,
 * sqlite.js) accepted whatever string they were handed. "This path has already
 * been checked" was a comment, and a comment had already been walked past once
 * — 2.7.1's acceptance called sqlite.js directly and read a file outside the
 * vault. Here the check hands back a branded value instead of a string, and
 * those modules refuse anything else.
 *
 * The brand is a frozen { path } registered in this module's private `issued`
 * map. Nothing outside this file can put an entry in it, so an object of the
 * same shape built by hand is not a path as far as pathOf() is concerned.
 * Deliberately not a class — `instanceof` is forged with
 * Object.create(SafePath.prototype); deliberately not a flag on the object —
 * a flag asks the caller to confirm, it does not check.
 *
 * The map is a WeakMap rather than a WeakSet, and its value is the PRIVATE
 * record of the resolver that issued the brand — not the object createResolver
 * hands back. That is what lets child() and parent() be plain module-level
 * functions that still know which vault a path belongs to (policy.js holds no
 * resolver of its own), while the brand constructor stays inside this file:
 * the returned resolver is frozen and exposes root, resolveSafe, child and
 * parent, none of which mints a brand for an unchecked string. Membership —
 * issued.has(x) — is the whole verification either way.
 *
 * Where the boundary honestly is: createResolver is exported, so code in this
 * process that deliberately builds a resolver over some other root will get
 * brands under that root, and they will pass pathOf(). That is not the attack
 * this defends against. It defends against a check that was forgotten, not
 * against one that was deliberately replaced — an in-process caller that wants
 * to go around it can always call fs directly anyway.
 *
 * UNVERIFIED_PATH means a module was called with a path that did not come from
 * here. It is an internal contract failure, not a user-visible refusal: every
 * tool resolves its argument before touching anything, so a client on /mcp
 * cannot produce it. Refusals about the vault boundary are a different error.
 */

const fs = require('fs');
const path = require('path');

// brand -> the resolver that issued it. Weak, so a brand holds nothing alive,
// and private, so only the code in this file can register one.
const issued = new WeakMap();

// Pure string containment, shared by everything that has to ask "is this under
// that". Not a bare startsWith(root): that accepts a sibling whose name merely
// shares the prefix (/media/VAULT_backup for /media/VAULT). Compares strings
// and touches no disk, so it takes no brand — callers pass `.path`.
function inside(p, root) {
  return p === root || p.startsWith(root + path.sep);
}

function isSafePath(x) {
  return issued.has(x);
}

// The gate every module puts in front of its own path arguments. `where` is
// the name of that module's function, so the message says who was called
// wrongly rather than where the check happens to live.
function pathOf(x, where) {
  if (!issued.has(x))
    throw new Error(`UNVERIFIED_PATH: ${where} requires a path produced by resolveSafe(), got ${typeof x}`);
  return x.path;
}

function describeName(name) {
  return typeof name === 'string' ? JSON.stringify(name.slice(0, 40)) : typeof name;
}

// One step DOWN from a path that is already verified. For tree walks only: the
// name comes from a readdir of that very directory, so there is no new
// containment question to answer and no realpath to pay for.
//
// The guarantee is LEXICAL — child() does not resolve symlinks. That is sound
// only because the walks using it do not follow them either (they test the
// dirent type, or lstat). Anything that decides where a write LANDS must go
// through resolveSafe(), never through child(): a name that came from a policy
// marker instead of from readdir can point at a symlink out of the vault.
function child(parent, name) {
  const base = pathOf(parent, 'child');
  // path.sep is redundant with '/' on the Alpine image and only matters when
  // this file is exercised from a Windows checkout — cheap, and it keeps
  // path.join() from ever seeing a separator it would honour.
  if (typeof name !== 'string' || !name || name.includes('/') || name.includes(path.sep) ||
      name.includes('\0') || name === '.' || name === '..')
    throw new Error(`UNVERIFIED_PATH: child() takes one path segment, got ${describeName(name)}`);
  return issued.get(parent).make(path.join(base, name));
}

// One step UP, with a full check — deliberately not the lexical dirname.
// resolveSafe() verifies realpath at the path itself, not at its ancestors, so
// the parent of a verified path is not automatically a verified path.
// Measured on 2.7.3: with tmp/fs280-out a symlink out of the vault and
// tmp/fs280-out/back a symlink back into it, write_file on the latter was
// accepted — the lexical parent chain ran through a directory outside the
// vault and the zone was read from the wrong side. Going up therefore costs a
// realpath, on every write. That is the price of the check being real.
function parent(p) {
  const dir = path.dirname(pathOf(p, 'parent'));
  return issued.get(p).resolveSafe(dir);
}

// One resolver per process and per root: server.js and the grep worker over
// ALLOWED_DIR, policy-ui.js over its own ROOT.
function createResolver(rootPath) {
  const ROOT = path.resolve(rootPath);

  // Real path of the vault, resolved once. The vault root itself is often
  // reached through a symlink on HAOS (/media → /mnt/data/supervisor/media),
  // so escape checks must compare against the resolved root, not the literal
  // one.
  let REAL_ROOT = ROOT;
  try { REAL_ROOT = fs.realpathSync(ROOT); } catch {}

  function make(p) {
    const b = Object.freeze({ path: p });
    issued.set(b, internal);
    return b;
  }

  // Hardened in 2.5.0. Two holes were closed:
  //   1. startsWith(ROOT) alone accepted sibling directories whose name
  //      merely shares the prefix (/media/VAULT_backup passed for /media/VAULT).
  //   2. Symlinks inside the vault pointing outside it were followed silently —
  //      `..` was blocked, a symlink was not.
  // For paths that do not exist yet (write_file, create_directory, move_file
  // destinations) the nearest existing ancestor is resolved instead.
  // The checks below are carried over unchanged from 2.7.3; only the return
  // value became a brand.
  function resolveSafe(p) {
    if (typeof p !== 'string' || !p) throw new Error('path must be a non-empty string');
    const resolved = path.resolve(p);
    if (!inside(resolved, ROOT)) throw new Error(`PATH_OUTSIDE_VAULT: ${p}`);
    let probe = resolved;
    for (;;) {
      try {
        const real = fs.realpathSync(probe);
        if (!inside(real, REAL_ROOT)) throw new Error(`PATH_OUTSIDE_VAULT: ${p} (symlink resolves outside the vault)`);
        return make(resolved);
      } catch (e) {
        if (e.code !== 'ENOENT') throw e;
        const up = path.dirname(probe);
        if (up === probe || !inside(up, ROOT)) throw new Error(`PATH_OUTSIDE_VAULT: ${p}`);
        probe = up;
      }
    }
  }

  // What the WeakMap stores. child() and parent() reach the constructor and
  // the check through it — never through the object returned below, which
  // carries no way to mint a brand.
  const internal = { make, resolveSafe };

  // The root is a root by definition — branded directly rather than resolved,
  // so a vault that does not exist yet still gives a usable resolver.
  return Object.freeze({ root: make(ROOT), resolveSafe, child, parent });
}

module.exports = { createResolver, isSafePath, pathOf, inside, child, parent };
