# Filesystem MCP Server — Home Assistant Addon

Home Assistant addon that exposes a local directory as an MCP (Model Context Protocol) server. Allows LLM agents like Claude to read and write files directly on your Home Assistant server.

## What is MCP?

[Model Context Protocol](https://modelcontextprotocol.io) is an open standard that allows AI assistants to connect to external tools and data sources. This addon lets Claude (or any MCP-compatible agent) read and write files in a directory on your HA server — useful for building a personal knowledge base, wiki, or any file-based workflow.

## Features

- Exposes a local directory (e.g. `/media/VAULT` or `/share/vault`) via MCP over HTTP (StreamableHTTP transport)
- Multi-arch: amd64, aarch64 (Raspberry Pi 4/5), armv7
- Token-based auth via URL prefix (`/private_<token>/`)
- Compatible with [claude.ai](https://claude.ai) custom connectors
- Configurable vault path — both `/media` and `/share` are mapped read-write
- Auto-creates vault structure and `CLAUDE.md` on first run (existing files are never overwritten)
- PDF reading support — page images (JPEG) via `read_media_file` (`#N` suffix) and `read_pdf_page`, cheap text extraction via `read_pdf_text` (pdftotext)
- `POST /write` endpoint for direct file overwrite from HA automations
- Optional request logging (`log_requests`) for debugging connector issues — see [Request logging](#request-logging-debugging)

## Community

💬 [Discussion thread on Home Assistant Community Forum](https://community.home-assistant.io/t/filesystem-mcp-server-expose-your-local-directory-to-claude-karpathy-llm-wiki-for-home-assistant/)

## Architecture support

| Architecture | Status |
|--------------|--------|
| amd64 | ✅ Tested (x86-64 servers and mini PCs) |
| aarch64 | ✅ Tested (Raspberry Pi 4, HA OS 2026.5.x — community-confirmed in [#1](https://github.com/st412m/ha-filesystem-mcp/issues/1)) |
| armv7 | 🟡 Builds, not field-tested — reports welcome |

## Where to put your vault

Two options, pick the one that fits your hardware:

### Option A: External USB drive at `/media/VAULT` (recommended for dedicated storage)

#### 1. Format the drive as ext4

Connect your USB drive to the HA server. Open the Terminal addon in HA and find the drive:

```bash
lsblk
```

Your drive will appear as `sdb`, `sdc`, or similar — the name depends on your system. Format it with ext4 and label it `VAULT`:

> ⚠️ This will erase all data on the drive. Replace `sdb` with your actual device name.

```bash
mkfs.ext4 -L VAULT /dev/sdb
```

#### 2. Install Samba NAS addon for auto-mounting

The [Samba NAS addon](https://github.com/dianlight/hassio-addons) handles automatic mounting of the drive at every HA startup.

1. Add the repository in **Settings → Add-ons → Add-on store → ⋮ → Repositories**:
   ```
   https://github.com/dianlight/hassio-addons
   ```
2. Install **Samba NAS** and start it

After the addon starts, your drive will be available at `/media/VAULT/` and will remount automatically on every reboot. You can verify in **Settings → System → Storage**.

### Option B: Built-in `/share` storage (no USB drive needed)

If the USB route is more friction than it's worth on your hardware (common on Raspberry Pi), you can keep the vault on HA's internal `/share` storage instead — no formatting, no extra addons:

```yaml
vault_path: "/share/vault"
```

The addon maps both `/media` and `/share` read-write, so any path under either works. Keep in mind that `/share` lives on the same disk/SD card as HA itself — for an SD-card Pi setup, consider regular backups of the vault.

## Installation

1. In Home Assistant go to **Settings → Add-ons → Add-on store**
2. Click **⋮ → Repositories** and add:
   ```
   https://github.com/st412m/ha-filesystem-mcp
   ```
3. Find **Filesystem MCP Server** and click **Install**

## Configuration

| Option | Description |
|--------|-------------|
| `token` | Secret token for auth. Generate with `cat /proc/sys/kernel/random/uuid` in HA terminal. Change from the default `changeme`! |
| `vault_path` | Path to expose via MCP — anywhere under `/media` or `/share` (default: `/media/VAULT`) |
| `log_requests` | Log every incoming request to the addon log (default: `false`). See [Request logging](#request-logging-debugging) |

Example:
```yaml
token: "your-uuid-here"
vault_path: "/media/VAULT"
log_requests: false
```

## Request logging (debugging)

When diagnosing connector problems — especially "claude.ai shows zero tools but curl works" — the key question is usually *did claude.ai's fetcher even reach my server?* Set `log_requests: true` in the addon configuration and restart the addon; the auth proxy will then log one line per incoming request:

```
[req] 2026-07-13T10:56:25.478Z 160.79.106.34 POST /private_***/mcp -> 200 172B ua="Claude-User"
```

Fields: timestamp, client IP (`CF-Connecting-IP`, falling back to `X-Forwarded-For`, then socket address), method, path, response status, response size, User-Agent. The secret token is always masked (`/private_***`), and unauthorized (401) probes are logged too. With the default `false` the proxy logs nothing, exactly as before.

Watch the log during a registration attempt: requests from Anthropic's published egress range (`160.79.104.0/21`) getting answered `200` mean the path works end to end; total silence means the requests never reached you — look upstream (tunnel, edge, or claude.ai itself). See the investigation in [#4](https://github.com/st412m/ha-filesystem-mcp/issues/4) for a worked example.

## What happens on first run

The addon automatically creates the following structure inside your vault if it doesn't exist yet:

```
/media/VAULT/
├── CLAUDE.md        # agent instructions (Karpathy wiki pattern)
├── log.md           # operation log
├── raw/             # drop your source files here
│   ├── ha/
│   └── projects/
└── wiki/            # LLM-compiled pages
    ├── ha/
    │   ├── devices/
    │   ├── automations/
    │   └── network/
    └── projects/
```

Initialization is guarded by existence checks: if `CLAUDE.md` or `log.md` already exist at `vault_path`, they are left untouched on every restart — pointing the addon at a pre-populated directory is safe.

You can drop files into `raw/` via the Samba share (`\\<your-ha-ip>\VAULT`) from Windows, or via SFTP.

> **Note on `CLAUDE.md`:** The auto-generated `CLAUDE.md` is just a starting point — a minimal template with basic instructions and vault structure. You are expected to customize it over time: add your device inventory, network topology, project context, MCP server constraints, and any rules specific to your setup. The more context you put in `CLAUDE.md`, the more useful Claude becomes across sessions. Think of it as a living document that grows with your smart home.

## Exposing externally (required for claude.ai)

To connect from claude.ai you need to expose port 3100 via your router.

For Keenetic routers:
1. **Port forwarding** — **Network rules → Port forwarding → Add rule**: incoming port `3100` → your HA server IP, port `3100`
2. **Domain** — **My networks and Wi-Fi → Domain name → Add**: name `vault-mcp`, device → your HA server, port `3100`

## Connecting to Claude

Your MCP endpoint will be:

```
https://vault-mcp.yourdomain.keenetic.link/private_<your-token>/mcp
```

Add this URL in **claude.ai → Settings → Connectors → Add custom connector**.

## POST /write endpoint

In addition to the MCP protocol, the addon exposes a simple HTTP endpoint for overwriting files directly from HA automations — useful for generating periodic snapshots without needing a full MCP client.

```
POST http://<ha-ip>:3100/private_<token>/write
Content-Type: application/json

{"path": "/media/VAULT/raw/ha/snapshot.md", "content": "# My snapshot\n..."}
```

To use from a Home Assistant automation, add a `rest_command` to `configuration.yaml`:

```yaml
rest_command:
  vault_write:
    url: !secret vault_write_url
    method: POST
    headers:
      Content-Type: "application/json"
    payload: '{"path":{{ path | tojson }},"content":{{ content | tojson }}}'
```

And in `secrets.yaml`:

```yaml
# vault_write_url keeps your token out of configuration.yaml and automations.
# Replace with your HA server's local IP, port 3100, and your addon token.
vault_write_url: "http://192.168.1.54:3100/private_<your-token>/write"
```

Then call it from an automation action:

```yaml
- variables:
    my_content: "# Snapshot\nDate: {{ now() }}"
- action: rest_command.vault_write
  data:
    path: "/media/VAULT/raw/ha/snapshot.md"
    content: "{{ my_content }}"
```

## Recommended companion addons

For the full Karpathy LLM wiki experience, also install:

- **[HA-MCP](https://github.com/homeassistant-ai/ha-mcp)** — gives Claude access to your Home Assistant entities, automations, and devices. Together with Filesystem MCP, Claude can read your HA state and write structured wiki pages about it.
- **Keenetic MCP** — if you use a Keenetic router, gives Claude access to network clients, DHCP, Wi-Fi, and VPN status.

## Security

- The token is embedded in the URL path — this is intentional, as claude.ai does not support custom auth headers for MCP connectors
- Never expose port 3100 to the internet without HTTPS
- Change the default token `changeme` before exposing externally
- Use a randomly generated UUID as your token

## Architecture

```
Claude (claude.ai)
    ↓ HTTPS
Reverse proxy (Keenetic / nginx / Cloudflare Tunnel)
    ↓ HTTP :3100
proxy.js (token auth, optional request logging)
    ↓ HTTP :3099
server.js (MCP StreamableHTTP + /write endpoint)
    ↓
/media/VAULT/ (your files)
```

## Changelog

- **2.3.2** — new `log_requests` option: opt-in request logging in the auth proxy (client IP, method, token-masked path, status, response size, User-Agent; 401 probes included) for debugging connector issues ([#4](https://github.com/st412m/ha-filesystem-mcp/issues/4)); no behavior changes with default settings
- **2.3.1** — GET `/mcp` now returns `405 Method Not Allowed` per the MCP Streamable HTTP spec instead of holding a dead SSE stream open (hung clients ~30s even on LAN, broke tool registration through buffering proxies like Cloudflare Tunnel); POST `/mcp` responds with plain `application/json` instead of a single-event SSE — immune to tunnel SSE buffering that could truncate large base64 payloads ([#4](https://github.com/st412m/ha-filesystem-mcp/issues/4))
- **2.3.0** — new `read_pdf_text` tool (pdftotext with layout preservation, optional page range); removed non-spec `structuredContent` duplication from all tool responses — roughly halves the payload for media results ([#3](https://github.com/st412m/ha-filesystem-mcp/issues/3)); `read_media_file` now actually returns the total PDF page count as documented; removed dead SVG rendering path (`read_pdf_page` always returned JPEG since 2.0.0)
- **2.2.2** — fix `TypeError` when MCP clients (claude.ai) serialize array parameters as JSON strings — affected `edit_file`, `read_multiple_files`, `search_files` ([#2](https://github.com/st412m/ha-filesystem-mcp/issues/2))
- **2.2.1** — multi-arch support (amd64/aarch64/armv7) via `build.yaml`; `share:rw` mapping so `vault_path` can live under `/share`; fixes build failure on Supervisor 2026.04+ ([#1](https://github.com/st412m/ha-filesystem-mcp/issues/1))
- **2.1.0** — `POST /write` endpoint for HA automations
- **2.0.0** — custom HTTP MCP server (StreamableHTTP), supergateway removed; PDF page reading

## License

MIT
