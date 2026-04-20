# Filesystem MCP Server — Home Assistant Addon

Home Assistant addon that exposes a local directory as an MCP (Model Context Protocol) server. Allows LLM agents like Claude to read and write files directly on your Home Assistant server.

## What is MCP?

[Model Context Protocol](https://modelcontextprotocol.io) is an open standard that allows AI assistants to connect to external tools and data sources. This addon lets Claude (or any MCP-compatible agent) read and write files in a directory on your HA server — useful for building a personal knowledge base, wiki, or any file-based workflow.

## Features

- Exposes a local directory (e.g. `/media/VAULT`) via MCP over HTTP
- Token-based auth via URL prefix (`/private_<token>/`)
- Compatible with [claude.ai](https://claude.ai) custom connectors
- Configurable vault path
- Auto-creates vault structure and `CLAUDE.md` on first run

## Architecture support

> ⚠️ Currently tested and supported on **amd64 only** (x86-64 servers and mini PCs).
> Raspberry Pi (aarch64/armv7) is not tested yet.
> If you successfully run this on a different architecture, please open an issue or PR — contributions welcome!

## Prerequisites: Setting up a USB drive

This addon is designed to work with an external USB drive mounted at `/media/VAULT`. Here's how to set it up:

### 1. Format the drive as ext4

Connect your USB drive to the HA server. Open the Terminal addon in HA and find the drive:

```bash
lsblk
```

Your drive will appear as `sdb`, `sdc`, or similar — the name depends on your system. Format it with ext4 and label it `VAULT`:

> ⚠️ This will erase all data on the drive. Replace `sdb` with your actual device name.

```bash
mkfs.ext4 -L VAULT /dev/sdb
```

### 2. Install Samba NAS addon for auto-mounting

The [Samba NAS addon](https://github.com/dianlight/hassio-addons) handles automatic mounting of the drive at every HA startup.

1. Add the repository in **Settings → Add-ons → Add-on store → ⋮ → Repositories**:
   ```
   https://github.com/dianlight/hassio-addons
   ```
2. Install **Samba NAS** and start it

After the addon starts, your drive will be available at `/media/VAULT/` and will remount automatically on every reboot. You can verify in **Settings → System → Storage**.

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
| `vault_path` | Path to expose via MCP (default: `/media/VAULT`) |

Example:
```yaml
token: "your-uuid-here"
vault_path: "/media/VAULT"
```

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

You can drop files into `raw/` via the Samba share (`\\<your-ha-ip>\VAULT`) from Windows, or via SFTP.

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
Reverse proxy (Keenetic / nginx)
    ↓ HTTP :3100
proxy.js (token auth middleware)
    ↓ HTTP :3099
supergateway (MCP-over-HTTP bridge)
    ↓ stdio
@modelcontextprotocol/server-filesystem
    ↓
/media/VAULT/ (your files)
```

## License

MIT
