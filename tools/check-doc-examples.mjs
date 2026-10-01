// Checks the documentation's examples of ha-filesystem-mcp against the source.
//
// Usage: node tools/check-doc-examples.mjs [repo-root]
// Exit code 1 if any check fails.

import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.argv[2] || '.';
const CYR = /[\u0400-\u04FF]/;
// A word character: letter, number or underscore.
const W = '[\\p{L}\\p{N}_]';

function read(p) {
  return fs.readFileSync(path.join(ROOT, p), 'utf8');
}

function listDir(dir, ext) {
  const full = path.join(ROOT, dir);
  return fs.readdirSync(full)
    .filter(n => !n.startsWith('.') && n.endsWith(ext) && fs.statSync(path.join(full, n)).isFile())
    .map(n => `${dir}/${n}`);
}

const SRC_FILES = [
  ...listDir('filesystem_mcp', '.js'),
  ...listDir('filesystem_mcp', '.sh'),
  'filesystem_mcp/config.yaml', 'filesystem_mcp/Dockerfile',
].sort();
const SRC = SRC_FILES.map(read).join('\n');
const SERVER = read('filesystem_mcp/server.js');

const DOC_FILES = ['README.md', 'filesystem_mcp/DOCS.md', ...listDir('docs', '.md').sort()];
const DOCS = Object.fromEntries(DOC_FILES.map(p => [p, read(p)]));

function squash(s) {
  return s.replace(/["'\\]/g, '').replace(/\s+/g, ' ');
}

const SRC_SQ = squash(SRC);

// --- TOOLS array --------------------------------------------------------------
const toolsBlock = SERVER.slice(SERVER.indexOf('const TOOLS = ['), SERVER.indexOf('async function callTool'));
const TOOLS = [...toolsBlock.matchAll(/^\s{4}name: '([a-z_]+)'/gm)].map(m => m[1]);

// --- Spans that are not claims about the code --------------------------------
// User content, shell commands for the host, Home Assistant UI values, external
// names. Every entry is a deliberate exception and is counted in the output.
const EXTERNAL = new Set([
  // host shell / setup
  'lsblk', 'mkfs.ext4 -L VAULT /dev/sdb', 'cat /proc/sys/kernel/random/uuid',
  'rsync --delete', '--backup-dir', 'sdb', 'shell_command', 'curl',
  'https://github.com/dianlight/hassio-addons', 'https://github.com/st412m/ha-filesystem-mcp',
  '\\\\<your-ha-ip>\\VAULT', '3100', '3100/tcp', 'vault-mcp',
  // example values / paths inside a user's vault
  '/share/vault', 'raw/', 'wiki/', 'raw/ha', 'raw/projects', 'wiki/projects', 'wiki/ha/{devices,automations,network}',
  'wiki/system/foo.md', 'wiki/.vault-trash/system/foo.md', 'foo__trash-20260905T050121Z.md',
  '/media/VAULT/raw/manual.pdf#3', '+03:00', '2026-09-13 07:31:02 +03:00', '-1', '-2',
  '"*.md,*.yaml"', 'include="*.md,*.yaml"', '.fydb', '.db', 'x', '`x`',
  'your-uuid-here', 'changeme',
  // SQL fragments suggested to the reader
  'hex(col)', 'length(col)', 'char(59)', 'group_concat()', 'hex()',
  // line-edit shapes written as objects (the fields are checked separately)
  '{startLine: 10, endLine: 12, newText: "x"}', '{startLine: 10, endLine: 12, newText: ""}',
  '{startLine: 10, newText: "x"}', '{startLine: lines+1, newText: "x"}', '{startLine: 13, newText: "x"}',
  'startLine: 1', '{oldText, newText}', '{startLine, endLine, newText}', '{oldText}', '{startLine}',
  'newText: ""', 'dryRun: true', 'counts: true', 'log_requests: true', 'lines',
  '\\n', '\\r\\n', '`#N`', '#N', '(a+)+', '.',
  // HTTP
  'POST /mcp', 'GET', 'POST', 'Content-Type: application/json', 'Allow: POST, OPTIONS',
  'Accept', 'CF-Connecting-IP', 'X-Forwarded-For',
  // repo files
  'README.md', 'LICENSE', 'filesystem_mcp/config.yaml', 'filesystem_mcp/Dockerfile', 'filesystem_mcp/run.sh',
  'filesystem_mcp/toolchain-check.sh', 'filesystem_mcp/proxy.js', 'filesystem_mcp/server.js',
  'filesystem_mcp/policy.js', 'filesystem_mcp/policy-ui.js', 'filesystem_mcp/retention.js',
  'filesystem_mcp/sqlite.js', 'filesystem_mcp/safepath.js',
  'test/make-fixtures.sh', 'VAULT_PATH=/media/VAULT test/make-fixtures.sh',
  'test/*.test.js', 'node:test', 'node --test "test/*.test.js"', 'node --check',
  'tools/check-doc-examples.mjs', 'tools/scan-secrets.mjs', '.github/workflows/ci.yml',
  'server.js', 'sqlite.js', 'policy.js', 'policy-ui.js', 'config.yaml', 'CLAUDE.md', 'log.md',
  'isError: true', '`isError: true`', 'Error: ', "{ type: 'text', text }", 'image', 'audio',
  'ingress_port', 'media:rw', 'share:rw', 'version', 'fork()', 'execArgv: []', 'callTool()',
  'resolveSafe()', 'guardWrite()', 'guardOverwrite()', 'TOOLS', 'description', 'inputSchema', 'name',
  'case', 'COPY', 'execFile', 'tools/list', 'listChanged: false', '/private_<token>', '/private_<token>/mcp',
  'https://<your-host>/private_<token>/mcp', '/mcp',
  'EXPECT_*_MAJOR', '`EXPECT_*_MAJOR`',
  // mapped by `share:rw` in config.yaml; the literal path is not in the source
  '/share',
  // Anthropic's published egress range, an external fact
  '160.79.104.0/21',
  // SQLite's own EXPLAIN QUERY PLAN vocabulary: sqlite3 emits these rows, the
  // source never writes them.
  'CO-ROUTINE', 'SCAN (subquery-N)',
  // produced by ternaries inside ${...}; checked by hand against server.js
  // (`${n}${isHit ? ':' : '-'} ` and `${existed ? 'Overwritten' : 'Written'}: `)
  '<number>: <text>', '<number>- <text>', 'Written:', 'Overwritten:',
]);

// Placeholders in docs (<path>, N, M, X, Y) stand for ${...} in the source.
const HOLE = '\x00';
const SRC_HOLES = SRC.replace(/\$\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/g, HOLE);

function holes(s) {
  s = s.replace(/<[^<>]+>/g, HOLE);
  return s.replace(new RegExp(`(?<!${W})[NMXY](?!${W})`, 'gu'), HOLE);
}

// Spans whose words must each appear in the source (object-shape examples).
const FIELD_WORDS = /[A-Za-z_]{3,}/g;

const results = { checked: 0, external: 0, failed: [] };

function fail(where, what) {
  results.failed.push(`${where}: ${what}`);
}

function found(cand) {
  if (SRC.includes(cand)) return true;
  const sq = squash(cand);
  if (sq && SRC_SQ.includes(sq)) return true;
  const h = holes(cand);
  if (h.includes(HOLE) && SRC_HOLES.includes(h)) return true;
  return false;
}

function stripFences(text) {
  return text.replace(/^(```|````)[\s\S]*?^\1\s*$/gm, '');
}

// A line quoted repr()-style for the failure message.
function pyRepr(s) {
  const q = s.includes("'") && !s.includes('"') ? '"' : "'";
  let out = '';
  for (const ch of s) {
    if (ch === '\\') out += '\\\\';
    else if (ch === q) out += '\\' + q;
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (ch.codePointAt(0) < 0x20 || ch.codePointAt(0) === 0x7f) out += '\\x' + ch.codePointAt(0).toString(16).padStart(2, '0');
    else out += ch;
  }
  return q + out + q;
}

// Inline backtick spans ---------------------------------------------------------
for (const [doc, text] of Object.entries(DOCS)) {
  const body = stripFences(text);
  for (const [, span] of body.matchAll(/`([^`\n]+)`/g)) {
    results.checked++;
    if (TOOLS.includes(span)) continue;
    if (EXTERNAL.has(span)) {
      results.external++;
      // object-shaped examples: every field name must still exist
      if (span.startsWith('{')) {
        for (const [w] of span.matchAll(FIELD_WORDS)) {
          if (w !== 'lines' && !SRC.includes(w)) fail(doc, `field \`${w}\` in \`${span}\` not in source`);
        }
      }
      continue;
    }
    const parts = span.split('…').map(p => p.trim()).filter(Boolean);
    if (!parts.every(found)) fail(doc, `\`${span}\` not found in source`);
  }
}

// Format strings in fenced blocks ---------------------------------------------
// Escapes ()[]{}?*+-|^$\.&~#, space and whitespace controls; the length test
// below counts the escaped form.
const PY_SPECIAL = new Set('()[]{}?*+-|^$\\.&~# \t\n\r\v\f');
function pyEscape(ch) {
  return PY_SPECIAL.has(ch) ? '\\' + ch : ch;
}

function templateRegexes(src) {
  const out = [];
  for (const m of src.matchAll(/`((?:[^`\\]|\\[^\n])*)`/g)) {
    const t = m[1];
    if (!t.includes('${')) continue;
    let rx = '';
    let i = 0;
    while (i < t.length) {
      if (t.startsWith('${', i)) {
        let depth = 1, j = i + 2;
        while (j < t.length && depth) {
          if (t[j] === '{') depth++;
          else if (t[j] === '}') depth--;
          j++;
        }
        rx += '.*?';
        i = j;
      } else {
        rx += pyEscape(t[i]);
        i++;
      }
    }
    if (rx.replace(/\.\*\?/g, '').length >= 3) out.push(new RegExp('^' + rx + '$'));
  }
  return out;
}

const TEMPLATES = templateRegexes(SRC);
const FORMAT_LINE = /( · rev | · lines |^\[req\] |^Policy: |^⚠ Policy: |^— \d+ match|^\s+\d+[:-] |^Pages? \d)/;
for (const [doc, text] of Object.entries(DOCS)) {
  for (const [, block] of text.matchAll(/^```[^\n]*\n([\s\S]*?)^```/gm)) {
    for (const line of block.split('\n')) {
      if (!FORMAT_LINE.test(line)) continue;
      results.checked++;
      if (SRC.includes(line) || TEMPLATES.some(t => t.test(line))) continue;
      fail(doc, `output line matches no template: ${pyRepr(line)}`);
    }
  }
}

// server.js templates that the documentation quotes must exist.
for (const needle of ["· rev ${revOf(buf.toString('utf8'))} · ${lines.length} lines",
                      '· rev ${revOf(text)} · lines ${start}-${end} of ${lines.length}',
                      'match(es) in ${r.files} file(s) · scanned',
                      ': ${p.path} · rev ${revOf(args.content)}',
                      'lines ${before} → ${lines.length} · rev ${rev0} → ${rev1}',
                      'edit(s) applied to ${p.path} · rev ${rev0} → ${revOf(text)}']) {
  results.checked++;
  if (!SERVER.includes(needle)) fail('server.js', `expected template missing: ${needle}`);
}

// No "Access denied" in docs ----------------------------------------------------
for (const [doc, text] of Object.entries(DOCS)) {
  results.checked++;
  if (text.includes('Access denied')) fail(doc, 'contains "Access denied"');
}

// No Cyrillic in echo lines of toolchain-check.sh --------------------------------
read('filesystem_mcp/toolchain-check.sh').split('\n').forEach((line, i) => {
  if (line.includes('echo')) {
    results.checked++;
    if (CYR.test(line)) fail('toolchain-check.sh', `line ${i + 1}: Cyrillic in echo`);
  }
});

// Every error code named in the docs exists in the source ----------------------
const CODE_RE = new RegExp(`(?<!${W})([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)(?!${W})`, 'gu');
const NOT_CODES = new Set(['VAULT_PATH', 'ADDON_VERSION', 'BUILD_VERSION', 'ALLOWED_DIR', 'REAL_ROOT',
  'EXPECT_NODE_MAJOR', 'EXPECT_POPPLER_MAJOR', 'EXPECT_SQLITE_MAJOR',
  'SQLITE_OPEN_READONLY', 'X_FORWARDED_FOR', 'CF_CONNECTING_IP']);
const codesSeen = new Set();
for (const [doc, text] of Object.entries(DOCS)) {
  for (const [, code] of text.matchAll(CODE_RE)) {
    if (NOT_CODES.has(code)) continue;
    codesSeen.add(code);
    results.checked++;
    if (!SRC.includes(code)) fail(doc, `error code ${code} is documented but not in the source`);
  }
}

// docs/tools.md covers exactly TOOLS ---------------------------------------------
const toolsMd = DOCS['docs/tools.md'];
const headed = [...toolsMd.matchAll(/^### `([a-z_]+)`$/gm)].map(m => m[1]);
for (const t of TOOLS) {
  results.checked++;
  if (!toolsMd.includes(`\`${t}\``)) fail('docs/tools.md', `tool ${t} not mentioned`);
}
for (const h of headed) {
  results.checked++;
  if (!TOOLS.includes(h)) fail('docs/tools.md', `heading ${h} is not in TOOLS`);
}
if (TOOLS.length !== 20) fail('server.js', `TOOLS has ${TOOLS.length} entries, expected 20`);

// DOCS.md links absolute; relative links elsewhere resolve ------------------------
function slug(h) {
  return h.toLowerCase().replace(new RegExp(`[^\\p{L}\\p{N}_\\- ]`, 'gu'), '').trim().replaceAll(' ', '-');
}

for (const [doc, text] of Object.entries(DOCS)) {
  for (const [, link] of text.matchAll(/\]\(([^)\s]+)\)/g)) {
    results.checked++;
    if (doc === 'filesystem_mcp/DOCS.md') {
      if (!link.startsWith('https://')) fail(doc, `relative link ${link}`);
      continue;
    }
    if (/^https?:\/\//.test(link)) continue;
    const hash = link.indexOf('#');
    const target = hash === -1 ? link : link.slice(0, hash);
    const anchor = hash === -1 ? '' : link.slice(hash + 1);
    const base = path.dirname(path.join(ROOT, doc));
    const p = target ? path.normalize(path.join(base, target)) : path.join(ROOT, doc);
    if (!fs.existsSync(p)) {
      fail(doc, `broken link ${link}`);
      continue;
    }
    if (anchor && fs.statSync(p).isFile()) {
      const heads = [...fs.readFileSync(p, 'utf8').matchAll(/^#+ (.+)$/gm)].map(m => m[1]);
      const slugs = new Set(heads.map(slug));
      if (!slugs.has(anchor)) fail(doc, `missing anchor ${link}`);
    }
  }
}

console.log(`tools in TOOLS: ${TOOLS.length}`);
console.log(`error codes named in docs: ${codesSeen.size} (${[...codesSeen].sort().join(', ')})`);
console.log(`candidates checked: ${results.checked}`);
console.log(`external (allow-listed, not code claims): ${results.external}`);
console.log(`failed: ${results.failed.length}`);
for (const f of results.failed) console.log('  FAIL ' + f);
process.exit(results.failed.length ? 1 : 0);
