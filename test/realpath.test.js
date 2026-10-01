'use strict';
// Policy by real place (directories reached through a symlink). Needs symlinks,
// so it is skipped on Windows.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const skip = process.platform === 'win32' ? 'symlink tests need a POSIX filesystem; they run in CI on Linux' : false;

// The vault is fixed when server.js is loaded, so it is set before require().
const T = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fsmcp-realpath-')));
process.argv[2] = T;
const S = require('../filesystem_mcp/server.js');
const P = require('../filesystem_mcp/policy.js');
const SP = require('../filesystem_mcp/safepath.js');

const J = (...a) => path.join(T, ...a);

function write(rel, text) {
  fs.mkdirSync(path.dirname(J(rel)), { recursive: true });
  fs.writeFileSync(J(rel), text);
}

if (!skip) {
  write('tmp/.keep', '');
  write('raw/.vault-policy', '{"readonly":true}\n');
  write('raw/ha/keep.txt', 'keep\n');
  write('arch/.vault-policy', '{"trash":".vault-trash"}\n');
  write('arch/old.txt', 'zzz-old\n');
  write('arch/.vault-trash/seed.txt', 'seed\n');
  write('arch/sub/note.md', 'needle\n');
  write('arch/sub2/.vault-policy', '{"trash":".bin"}\n');
  write('arch/sub2/.bin/x.txt', 'zzz-old\n');
  fs.symlinkSync(J('raw/ha'), J('tmp/r-link'), 'dir');
  fs.symlinkSync(J('arch'), J('tmp/a-link'), 'dir');
}

test.after(() => fs.rmSync(T, { recursive: true, force: true }));

async function call(name, args) {
  const r = await S.handleMcpRequest({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  return { text: r.result.content.map(c => c.text).join('\n'), isError: r.result.isError === true };
}

// --- policy.js ----------------------------------------------------------------

test('policy of a directory reached through a symlink is the policy of its real place', { skip }, () => {
  const R = SP.createResolver(T);
  const r = P.policyAt(R.resolveSafe(J('tmp/r-link')), R.root);
  assert.equal(r.policy.readonly, true);
  assert.equal(r.real.path, J('raw/ha'));

  const a = P.policyForDir(R.resolveSafe(J('tmp/a-link')), R.root);
  assert.equal(P.trashDirOf(a).path, J('arch/.vault-trash'));
  assert.equal(a.trashOwner.path, J('arch'));

  // a path that does not exist yet keeps its tail
  assert.equal(SP.canonical(R.resolveSafe(J('tmp/a-link/new/deeper'))).path, J('arch/new/deeper'));
});

test('without symlinks nothing changes', { skip }, () => {
  const R = SP.createResolver(T);
  const dir = R.resolveSafe(J('arch'));
  const r = P.policyAt(dir, R.root);
  assert.equal(r.real.path, dir.path);
  assert.equal(r.policy.source, J('arch'));
  assert.equal(P.describePolicy(r.policy, dir.path, r.real.path),
    `Policy: overwrite=free, trash=.vault-trash — own marker (${J('arch/.vault-policy')})`);
  assert.equal(P.describePolicy(r.policy, dir.path), P.describePolicy(r.policy, dir.path, r.real.path));
});

// --- tools --------------------------------------------------------------------

test('writes through a symlink into a read-only zone are refused', { skip }, async () => {
  let r = await call('write_file', { path: J('tmp/r-link/new.txt'), content: 'x\n' });
  assert.ok(r.isError);
  assert.ok(r.text.includes(`Refused — ${J('raw/ha')} is read-only by policy`), r.text);
  assert.equal(fs.existsSync(J('raw/ha/new.txt')), false);

  r = await call('create_directory', { path: J('tmp/r-link/sub') });
  assert.ok(r.isError && r.text.includes('read-only by policy'), r.text);

  r = await call('move_file', { source: J('tmp/r-link/keep.txt'), destination: J('tmp/moved.txt') });
  assert.ok(r.isError && r.text.includes('read-only by policy'), r.text);
  assert.ok(fs.existsSync(J('raw/ha/keep.txt')));
});

test('listing through a symlink prints the real policy and where it resolves', { skip }, async () => {
  let r = await call('list_directory', { path: J('tmp/r-link') });
  assert.ok(!r.isError);
  assert.equal(r.text.split('\n')[0],
    `Policy: read-only, no trash (deletion not available) — inherited from ${J('raw/.vault-policy')} (via symlink: resolves to ${J('raw/ha')})`);

  r = await call('list_directory', { path: J('tmp/a-link') });
  assert.ok(!r.isError);
  assert.equal(r.text.split('\n')[0],
    `Policy: overwrite=free, trash=.vault-trash — own marker (${J('arch/.vault-policy')}) (via symlink: resolves to ${J('arch')})`);
  assert.ok(!r.text.includes('looks like a trash directory'), r.text);
});

test('the trash reached through a symlink stays the trash', { skip }, async () => {
  write('tmp/plain.txt', 'plain\n');
  let r = await call('move_file', { source: J('tmp/plain.txt'), destination: J('tmp/a-link/.vault-trash/hand.txt') });
  assert.ok(r.isError && r.text.includes('use trash_file'), r.text);
  assert.ok(fs.existsSync(J('tmp/plain.txt')));

  r = await call('read_multiple_files', { paths: [J('tmp/a-link/.vault-trash/seed.txt')] });
  assert.ok(r.text.includes('bulk reads skip it'), r.text);

  r = await call('trash_file', { path: J('tmp/a-link/.vault-trash/seed.txt') });
  assert.ok(r.isError && r.text.includes('is already in the trash'), r.text);
  assert.ok(fs.existsSync(J('arch/.vault-trash/seed.txt')));
});

test('trash_file through a symlink lands in the real trash, path kept relative to its owner', { skip }, async () => {
  const r = await call('trash_file', { path: J('tmp/a-link/old.txt') });
  assert.ok(!r.isError, r.text);
  assert.match(r.text, new RegExp(`→ ${J('arch/.vault-trash/old__trash-').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\d{8}T\\d{6}Z\\.txt`));
  assert.equal(fs.existsSync(J('arch/old.txt')), false);
  assert.equal(fs.existsSync(J('arch/tmp')), false);
  assert.ok(fs.readdirSync(J('arch/.vault-trash')).some(n => n.startsWith('old__trash-')));
});

test('walks from a symlinked root skip every trash, its own and a subzone\'s', { skip }, async () => {
  let r = await call('grep_files', { path: J('tmp/a-link'), pattern: 'zzz-old' });
  assert.ok(!r.isError, r.text);
  assert.ok(r.text.startsWith('No matches.'), r.text);

  r = await call('grep_files', { path: J('tmp/a-link'), pattern: 'needle' });
  assert.ok(!r.isError, r.text);
  assert.ok(r.text.startsWith(`${J('tmp/a-link/sub/note.md')} · rev `), r.text);

  r = await call('search_files', { path: J('tmp/a-link'), pattern: 'x.txt' });
  assert.equal(r.text, 'No matches\n\n(2 trash directories not searched)');

  r = await call('search_files', { path: J('tmp/a-link'), pattern: 'note' });
  assert.equal(r.text, `${J('tmp/a-link/sub/note.md')}\n\n(2 trash directories not searched)`);

  r = await call('directory_tree', { path: J('tmp/a-link') });
  assert.ok(!r.isError, r.text);
  assert.ok(!r.text.includes('__trash-') && !r.text.includes('seed.txt') && !r.text.includes('x.txt'), r.text);
  assert.ok(r.text.includes('(2 trash directories omitted'), r.text);
});
