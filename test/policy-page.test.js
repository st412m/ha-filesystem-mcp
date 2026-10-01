'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Read when policy-ui.js is loaded.
const V = fs.mkdtempSync(path.join(os.tmpdir(), 'fsmcp-page-'));
process.argv[2] = V;
process.env.ALLOW_LOCAL = 'true';
process.env.POLICY_PAGE_USERS = 'alice\n  \n';
const { pageUserAllowed, server } = require('../filesystem_mcp/policy-ui.js');

test.after(() => fs.rmSync(V, { recursive: true, force: true }));

const LIST = ['alice', '0123456789abcdef'];
const ID = 'X-Remote-User-Id', NAME = 'X-Remote-User-Name';

test('an empty list lets every user in', () => {
  assert.equal(pageUserAllowed([], []), true);
  assert.equal(pageUserAllowed([ID, 'someone', NAME, 'bob'], []), true);
});

test('a listed name or ID is let in', () => {
  assert.equal(pageUserAllowed([ID, 'ffff', NAME, 'alice'], LIST), true);
  assert.equal(pageUserAllowed([ID, '0123456789abcdef', NAME, 'bob'], LIST), true);
  assert.equal(pageUserAllowed([ID, '0123456789abcdef'], LIST), true);
  assert.equal(pageUserAllowed(['x-remote-user-id', 'ffff', 'x-remote-user-name', 'alice'], LIST), true);
});

test('missing headers, repeated headers or a different case of the value are refused', () => {
  assert.equal(pageUserAllowed([], LIST), false);
  assert.equal(pageUserAllowed([NAME, 'alice'], LIST), false);
  assert.equal(pageUserAllowed([ID, 'ffff', NAME, 'bob'], LIST), false);
  assert.equal(pageUserAllowed([ID, 'ffff', 'X-Remote-User-Name', 'alice', 'x-remote-user-name', 'alice'], LIST), false);
  assert.equal(pageUserAllowed([ID, '0123456789abcdef', 'x-remote-user-id', '0123456789abcdef'], LIST), false);
  assert.equal(pageUserAllowed([ID, 'ffff', NAME, 'Alice'], LIST), false);
  assert.equal(pageUserAllowed([ID, '0123456789ABCDEF'], LIST), false);
});

test('HTTP: a user not in policy_page_users gets 403 on every route', async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const route of ['/', '/api/tree', '/anything']) {
      const r = await fetch(base + route, { headers: { [ID]: 'ffff', [NAME]: 'bob' } });
      assert.equal(r.status, 403, route);
      assert.equal(r.headers.get('content-type'), 'text/plain');
      assert.equal(await r.text(), 'Forbidden: this Home Assistant user is not listed in policy_page_users\n');
    }
    const ok = await fetch(base + '/api/tree', { headers: { [ID]: 'ffff', [NAME]: 'alice' } });
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).vault, path.resolve(V));
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
