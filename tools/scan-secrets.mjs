// Scans the repository for values that must not be published: private
// addresses, MACs, tokens, personal paths and e-mail addresses.
//
// Usage: node tools/scan-secrets.mjs
// Files: tracked plus untracked-but-not-ignored (git ls-files). Exit code 1 on
// any finding. Findings are printed without the matched value.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const files = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8' })
  .split('\0').filter(Boolean);

// Documentation ranges (RFC 5737), loopback and the Supervisor address.
function allowedIp(ip) {
  return ip === '172.30.32.2' || ip === '127.0.0.1' ||
    /^(192\.0\.2|198\.51\.100|203\.0\.113)\.\d+$/.test(ip);
}

function privateIp(ip) {
  const o = ip.split('.').map(Number);
  if (o.some(n => n > 255)) return false;
  return o[0] === 10 || (o[0] === 172 && o[1] >= 16 && o[1] <= 31) || (o[0] === 192 && o[1] === 168);
}

const RULES = [
  { kind: 'private IPv4', re: /(?<![\d.])\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}(?![\d.]?\d)/g,
    keep: m => privateIp(m) && !allowedIp(m) },
  { kind: 'MAC address', re: /(?<![0-9A-Fa-f:-])(?:[0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}(?![0-9A-Fa-f:-])/g },
  { kind: 'token path prefix', re: /private_[A-Za-z0-9_-]{8,}/g },
  { kind: 'Windows user path', re: /[A-Za-z]:[\\/]+Users[\\/]+[^\\/\s'"`]+/gi },
  { kind: 'home directory', re: /\/home\/[a-z_][a-z0-9_.-]*/g },
  { kind: 'long hex string', re: /(?<![0-9A-Fa-f])[0-9A-Fa-f]{32,}(?![0-9A-Fa-f])/g },
  { kind: 'long base64 string', re: /(?<![A-Za-z0-9+/])[A-Za-z0-9+/]{40,}={0,2}/g,
    keep: m => /[a-z]/.test(m) && /[A-Z]/.test(m) && /\d/.test(m) },
  { kind: 'token', re: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|sk-[A-Za-z0-9_-]{20,}|xox[abposr]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|glpat-[A-Za-z0-9_-]{20,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})/g },
  { kind: 'private key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
  { kind: 'e-mail address', re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g,
    // the maintainer address, by position rather than by value
    skipLine: (file, line) => file === 'repository.yaml' && /^maintainer:/.test(line) },
];

let findings = 0;
let scanned = 0;
for (const file of files) {
  let buf;
  try { buf = fs.readFileSync(file); } catch { continue; }
  if (buf.subarray(0, 8192).includes(0)) continue;          // binary
  scanned++;
  const lines = buf.toString('utf8').split('\n');
  lines.forEach((line, i) => {
    for (const rule of RULES) {
      if (rule.skipLine && rule.skipLine(file, line)) continue;
      for (const m of line.matchAll(rule.re)) {
        if (rule.keep && !rule.keep(m[0])) continue;
        findings++;
        console.log(`${file}:${i + 1}:${m.index + 1}: ${rule.kind} (${m[0].length} chars)`);
      }
    }
  });
}

console.log(`files scanned: ${scanned}`);
console.log(`findings: ${findings}`);
process.exit(findings ? 1 : 0);
