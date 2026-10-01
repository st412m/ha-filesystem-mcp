'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const SP = require('../filesystem_mcp/safepath.js');
const P = require('../filesystem_mcp/policy.js');

const V = fs.mkdtempSync(path.join(os.tmpdir(), 'fsmcp-policy-'));
const R = SP.createResolver(V);
const J = (...a) => path.join(V, ...a);

function write(rel, text) {
  fs.mkdirSync(path.dirname(J(rel)), { recursive: true });
  fs.writeFileSync(J(rel), text);
}

const policyOf = rel => P.policyForDir(R.resolveSafe(J(rel)), R.root, new Map());

test.after(() => fs.rmSync(V, { recursive: true, force: true }));

test('parseMarker accepts the known fields', () => {
  assert.deepEqual(P.parseMarker('{"_":"note","readonly":false,"overwrite":"rev","trash":".t","retention_enabled":true,"retention_days":7}'),
    { readonly: false, overwrite: 'rev', trash: '.t', retention_enabled: true, retention_days: 7 });
  assert.deepEqual(P.parseMarker('{"trash":null}'), { trash: null });
});

test('parseMarker refuses what it does not know', () => {
  assert.throws(() => P.parseMarker('{"readonly":true,"color":"red"}'), /unknown field "color"/);
  assert.throws(() => P.parseMarker('{"readonly":tru'), /invalid JSON/);
  assert.throws(() => P.parseMarker('[]'), /must be a JSON object/);
  assert.throws(() => P.parseMarker('{"overwrite":"maybe"}'), /"overwrite" must be one of/);
  for (const d of [0, 3651, 1.5, '30'])
    assert.throws(() => P.parseMarker(JSON.stringify({ retention_days: d })), /"retention_days"/, String(d));
  assert.deepEqual(P.parseMarker('{"retention_days":1}'), { retention_days: 1 });
  assert.deepEqual(P.parseMarker('{"retention_days":3650}'), { retention_days: 3650 });
  for (const t of ['a/b', 'a\\b', '..', '.', '.vault-policy', ''])
    assert.throws(() => P.parseMarker(JSON.stringify({ trash: t === '' ? 1 : t })), /"trash"/, t);
});

test('no marker anywhere: unrestricted', () => {
  fs.mkdirSync(J('free'), { recursive: true });
  const p = policyOf('free');
  assert.equal(p.readonly, false);
  assert.equal(p.overwrite, 'free');
  assert.equal(p.source, null);
  assert.equal(P.describePolicy(p, J('free')), 'Policy: none — unrestricted (no .vault-policy marker above this directory).');
});

test('fields are inherited one by one', () => {
  write('wiki/.vault-policy', '{"overwrite":"rev","trash":".vault-trash","retention_enabled":true,"retention_days":14}');
  write('wiki/locked/.vault-policy', '{"readonly":true}');
  fs.mkdirSync(J('wiki/locked/deeper'), { recursive: true });

  const w = policyOf('wiki');
  assert.equal(w.overwrite, 'rev');
  assert.equal(P.trashDirOf(w).path, J('wiki/.vault-trash'));

  const d = policyOf('wiki/locked/deeper');
  assert.equal(d.readonly, true);
  assert.equal(d.overwrite, 'rev');
  assert.equal(d.trash, '.vault-trash');
  assert.equal(d.trashOwner.path, J('wiki'));
  assert.equal(d.retention_days, 14);
  assert.equal(d.source, J('wiki/locked'));
  assert.equal(P.describePolicy(d, J('wiki/locked/deeper')),
    `Policy: read-only, trash=.vault-trash in ${J('wiki')}, auto-purge after 14 d — inherited from ${J('wiki/locked/.vault-policy')}`);
});

test('a broken marker locks its whole subtree, valid markers below included', () => {
  write('broken/.vault-policy', '{"readonly":fals');
  write('broken/inner/.vault-policy', '{"overwrite":"free"}');
  for (const rel of ['broken', 'broken/inner']) {
    const p = policyOf(rel);
    assert.ok(p.error, rel);
    assert.equal(p.readonly, true);
    assert.equal(p.overwrite, 'never');
    assert.ok(P.describePolicy(p, J(rel)).startsWith('⚠ Policy: BROKEN MARKER — zone locked (read-only, no deletion). '));
  }
  fs.mkdirSync(J('dirmarker/.vault-policy'), { recursive: true });
  assert.match(policyOf('dirmarker').error, /is not a regular file/);
});

test('trash stamps go there and back', () => {
  const d = new Date(Date.UTC(2026, 8, 5, 5, 1, 21));
  const stamp = P.stampNow(d);
  assert.equal(stamp, '__trash-20260905T050121Z');
  assert.equal(P.stampName('foo.md', stamp), 'foo__trash-20260905T050121Z.md');
  assert.equal(P.stampName('README', stamp), 'README__trash-20260905T050121Z');
  assert.equal(P.stampOf('foo__trash-20260905T050121Z.md').getTime(), d.getTime());
  assert.equal(P.stampOf('foo__trash-20260905T050121Z-3.md').getTime(), d.getTime());
  assert.equal(P.stampOf('foo.md'), null);
});
