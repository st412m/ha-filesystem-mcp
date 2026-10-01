'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const SP = require('../filesystem_mcp/safepath.js');
const P = require('../filesystem_mcp/policy.js');

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'fsmcp-brand-'));
const V = path.join(base, 'vault');
fs.mkdirSync(V);
fs.mkdirSync(V + '_backup');
fs.writeFileSync(path.join(V + '_backup', 'probe.txt'), 'outside\n');
const R = SP.createResolver(V);

test.after(() => fs.rmSync(base, { recursive: true, force: true }));

test('only a path produced by resolveSafe is accepted', () => {
  const fakes = [
    { path: '/etc/passwd' },
    Object.freeze({ path: path.join(V, 'x') }),
    Object.create(R.root),
    path.join(V, 'x'),
  ];
  for (const f of fakes) {
    assert.throws(() => SP.pathOf(f, 'test'), /UNVERIFIED_PATH/);
    assert.throws(() => P.policyForDir(f, R.root), /UNVERIFIED_PATH/);
    assert.throws(() => SP.child(f, 'a'), /UNVERIFIED_PATH/);
    assert.throws(() => SP.canonical(f), /UNVERIFIED_PATH/);
  }
  assert.equal(SP.pathOf(R.resolveSafe(path.join(V, 'x')), 'test'), path.join(V, 'x'));
});

test('a sibling directory sharing the name prefix is outside the vault', () => {
  assert.throws(() => R.resolveSafe(path.join(V + '_backup', 'probe.txt')), /PATH_OUTSIDE_VAULT/);
  assert.throws(() => R.resolveSafe(path.join(V, '..', 'vault_backup', 'probe.txt')), /PATH_OUTSIDE_VAULT/);
  assert.throws(() => R.resolveSafe(path.join(V, '..')), /PATH_OUTSIDE_VAULT/);
});

test('the resolver hands out no brand constructor', () => {
  assert.equal('make' in R, false);
  assert.deepEqual(Object.keys(R).sort(), ['canonical', 'child', 'parent', 'resolveSafe', 'root']);
  assert.ok(Object.isFrozen(R));
  assert.ok(Object.isFrozen(R.root));
});

test('child() takes one segment only', () => {
  for (const bad of ['..', '.', 'a/b', '', 'a\0b'])
    assert.throws(() => SP.child(R.root, bad), /UNVERIFIED_PATH/);
});

test('canonical() of a path without symlinks is the path itself, a missing tail included', () => {
  const p = R.resolveSafe(path.join(V, 'not', 'there', 'yet'));
  assert.equal(SP.canonical(p).path, p.path);
  assert.equal(SP.canonical(R.root).path, R.root.path);
});
