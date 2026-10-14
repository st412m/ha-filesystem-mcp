#!/usr/bin/env node
// Release consistency of the Home Assistant app, also run by CI. Checks
// - filesystem_mcp/config.yaml version = the top entry of filesystem_mcp/CHANGELOG.md;
// - that entry names the server ("Server: everkeep x.y.z"), and the everkeep@x.y.z
//   pin in filesystem_mcp/Dockerfile is that version;
// - filesystem_mcp/Dockerfile.local installs everkeep-x.y.z.tgz of the same version.
// No dependencies, no network.
//
//   node tools/check-release.mjs
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '..');
const APP = 'filesystem_mcp';
const SERVER_RE = /^Server: everkeep (\d+\.\d+\.\d+)\s*$/m;

function read(root, rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}

// The top "## <version>" entry of the changelog: its version and its text.
function topEntry(changelog) {
  const m = /^## (\S+)[^\n]*\n([\s\S]*?)(?=^## |(?![\s\S]))/m.exec(changelog);
  return m ? { version: m[1], body: m[2] } : null;
}

/** Returns { problems, version, everkeep }; problems is empty when the release is consistent. */
export function checkRelease(root = ROOT) {
  const problems = [];
  const config = read(root, `${APP}/config.yaml`);
  const version = /^version:\s*"?([^"\s]+)"?\s*$/m.exec(config)?.[1];
  const entry = topEntry(read(root, `${APP}/CHANGELOG.md`));
  if (!version) problems.push(`${APP}/config.yaml has no version`);
  if (!entry) problems.push(`${APP}/CHANGELOG.md has no "## <version>" entry`);
  else if (entry.version !== version) problems.push(`${APP}/CHANGELOG.md top entry is ${entry.version}, ${APP}/config.yaml version is ${version}`);

  const everkeep = entry && SERVER_RE.exec(entry.body)?.[1];
  if (entry && !everkeep) problems.push(`${APP}/CHANGELOG.md entry ${entry.version} does not name the server ("Server: everkeep x.y.z")`);
  const pin = /\beverkeep@([^\s\\]+)/.exec(read(root, `${APP}/Dockerfile`))?.[1];
  if (everkeep && pin !== everkeep) problems.push(`${APP}/Dockerfile installs everkeep@${pin ?? '(missing)'}, the changelog entry names everkeep ${everkeep}`);

  const localFile = `${APP}/Dockerfile.local`;
  if (fs.existsSync(path.join(root, localFile))) {
    const tarballs = [...new Set([...read(root, localFile).matchAll(/\beverkeep-([^\s/\\]+)\.tgz\b/g)].map(m => m[1]))];
    if (everkeep && (tarballs.length !== 1 || tarballs[0] !== everkeep))
      problems.push(`${localFile} installs ${tarballs.length ? tarballs.map(v => `everkeep-${v}.tgz`).join(', ') : 'no everkeep tarball'}, the changelog entry names everkeep ${everkeep}`);
  }
  return { problems, version, everkeep };
}

function isMain() {
  try {
    return import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

if (isMain()) {
  const { problems, version, everkeep } = checkRelease();
  for (const p of problems) console.error(`check-release: ${p}`);
  if (problems.length) process.exitCode = 1;
  else console.log(`check-release: app ${version}, everkeep ${everkeep} pinned`);
}
