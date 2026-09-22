# Internals

How the app is put together: processes, ports, modules, how a tool is added, and the traps worth knowing before changing the code. Read this before sending a patch.

## Processes and ports

`run.sh` starts three Node.js processes in one container:

```
Claude (claude.ai)
    ↓ HTTPS
Reverse proxy (router domain service / nginx / Cloudflare Tunnel)
    ↓ HTTP :3100
proxy.js      token prefix check, forwards /mcp only, optional request log
    ↓ HTTP :3099
server.js     MCP Streamable HTTP, all tools
    ↓
vault_path
    ↑
policy-ui.js  :3101, ingress only, the only writer of .vault-policy
    ↑ HTTP, from 172.30.32.2 only
Home Assistant sidebar → "Vault policies"
```

| Command in `run.sh` | Port | |
|---|---|---|
| `node /server.js "${VAULT_PATH}" 3099` | 3099 | MCP server, container-internal |
| `node /policy-ui.js "${VAULT_PATH}" 3101` | 3101 | policy page, `ingress_port` in `config.yaml` |
| `node /proxy.js` | 3100 | auth proxy, published as `3100/tcp` |

Before starting them, `run.sh` reads the options through bashio, prints the toolchain banner (`toolchain-check.sh runtime`) and the build manifest, and seeds the vault skeleton once (flag `/data/.vault-structure-initialized`).

The server speaks JSON-RPC over `POST /mcp` and answers with `Content-Type: application/json`. `GET` gets 405, an `Accept` header with neither `application/json` nor `text/event-stream` gets 406, and any path other than `/mcp` gets 404. The server sends no notifications, and `tools/list` is static (`listChanged: false`).

## Modules

| File | Responsibility |
|---|---|
| `filesystem_mcp/config.yaml` | add-on manifest: version, arch, ports, ingress, `media:rw` / `share:rw` maps, option schema |
| `filesystem_mcp/Dockerfile` | base image, `apk add --no-cache nodejs poppler-utils sqlite`, one `COPY` per file, build-time `toolchain-check.sh build` |
| `filesystem_mcp/run.sh` | reads options, prints the banner, seeds the vault once, starts the three processes |
| `filesystem_mcp/toolchain-check.sh` | `build`: major-version guard and smoke test of PDF and SQLite; `runtime`: version banner |
| `filesystem_mcp/proxy.js` | token prefix, `/mcp` allow-list, `log_requests` |
| `filesystem_mcp/server.js` | HTTP endpoint, JSON-RPC dispatch, the `TOOLS` array, `callTool()`, `resolveSafe()`, `rev`, the grep worker |
| `filesystem_mcp/policy.js` | reading and merging `.vault-policy` markers, trash stamps, the policy line printed by listing tools |
| `filesystem_mcp/policy-ui.js` | the Vault policies page and the only code that writes markers |
| `filesystem_mcp/retention.js` | the trash auto-purge sweep |
| `filesystem_mcp/sqlite.js` | `sqlite_schema` and `sqlite_query`: open strategy, statement checks, memory-limit confirmation |
| `test/make-fixtures.sh` | builds throwaway SQLite databases for testing: `VAULT_PATH=/media/VAULT test/make-fixtures.sh` |

There are no npm dependencies. Everything uses Node's built-in modules and the `pdftotext`, `pdftoppm`, `pdfinfo` and `sqlite3` binaries, called with `execFile` and an argument array, never through a shell.

The add-on version has a single source: `version` in `config.yaml` → `BUILD_VERSION` build argument → `ADDON_VERSION` environment variable, read by `server.js`, `policy-ui.js` and `run.sh`.

## Adding a tool

1. Add an entry to the `TOOLS` array in `server.js`: `name`, a short `description`, and `inputSchema`. Everything in `TOOLS` is sent to the client with `tools/list` in every session, so keep descriptions short.
2. Add a `case` to `callTool()`. Pass every path argument through `resolveSafe()` first. For anything that writes, call `guardWrite()` and, for an existing target, `guardOverwrite()`.
3. Return an array of MCP content blocks (`{ type: 'text', text }`, `image` or `audio`). Throw to report an error; the dispatcher turns it into `isError: true`.
4. If the tool lives in a new file, add a `COPY` line for it to the Dockerfile.
5. Document it in the README's Tools list and in [tools.md](tools.md), add a changelog entry, and bump `version` in `config.yaml`.

## Traps

### `COPY` in the Dockerfile

The Dockerfile copies each file by name. A new `.js` module without its own `COPY` line builds fine and fails at runtime with a missing-module error.

### Toolchain pinning

Alpine packages cannot be pinned to an exact `-rN` release: old releases are removed from the branch, and a pin breaks installation for everyone. So packages float within the Alpine branch, and `toolchain-check.sh build` fails the build when the major version of nodejs, poppler or sqlite3 differs from `EXPECT_NODE_MAJOR`, `EXPECT_POPPLER_MAJOR` or `EXPECT_SQLITE_MAJOR`, or when the smoke test fails. The smoke test renders and extracts a generated PDF with the same flags the server uses, runs `sqlite3` with the same command line as `sqlite.js`, checks the `hard_heap_limit` echo, and verifies that `-safe` blocks `ATTACH`. After a base-image change, run `read_pdf_text`, `read_pdf_page` and `sqlite_query` by hand, then update the `EXPECT_*_MAJOR` values.

### The forked grep worker

`grep_files` runs in a forked copy of `server.js` (`--grep-worker <vault>`), which is killed after 10 seconds. Node cannot interrupt a running regex, so the child process is the only reliable stop. Keep `execArgv: []` in the `fork()` call; the child must not inherit the parent's Node flags.

### `resolveSafe()` is the zone check

`resolveSafe()` in `server.js` is where a path is confined to the vault: it rejects paths outside `vault_path`, symlinks resolving outside it, and sibling directories that share its name prefix. `sqlite.js` and `policy.js` do no containment check of their own and trust that the path they are given has already passed through `resolveSafe()`. Never call them with a raw argument. `policy-ui.js` has its own copy of the same check.

### Markers are written in one place

Only `policy-ui.js` writes `.vault-policy`, and it is not reachable through the token URL. `server.js` has no reference to that code, and its tools refuse any path named `.vault-policy`. Keep it that way.

### Comments in Russian

Comments in `run.sh`, `toolchain-check.sh` and the Dockerfile, and a few block comments in the `.js` files, are in Russian. They are the author's working notes and stay as they are. Everything a user sees, including log and build messages, is in English; keep new user-facing strings in English.
