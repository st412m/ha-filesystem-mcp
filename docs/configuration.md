# Configuration

The app's options, where to put the vault, what the first start creates, and how to reach the server from outside. Read this when installing, when moving the vault, or when a connector cannot reach the server.

## Options

| Option | Type | Default | |
|---|---|---|---|
| `token` | string | `changeme` | Secret in the URL path: the endpoint is `/private_<token>/mcp` on port 3100. |
| `vault_path` | string | `/media/VAULT` | The directory the server exposes. Everything outside it is unreachable. |
| `log_requests` | bool | `false` | One log line per request in the auth proxy. |

Generate a token with `cat /proc/sys/kernel/random/uuid` in the Home Assistant terminal. Changing an option takes effect after restarting the app.

## Ports

| Port | Process | Reachable from |
|---|---|---|
| 3100 | auth proxy (`proxy.js`) | published on the host as 3100/tcp |
| 3099 | MCP server (`server.js`) | inside the container only |
| 3101 | Vault policies page (`policy-ui.js`) | Home Assistant ingress only |

## Where to put the vault

The app maps both `/media` and `/share` read-write, so `vault_path` can be any directory under either.

### Option A: a USB drive under `/media`

1. Connect the drive and find it in the Home Assistant terminal:

   ```bash
   lsblk
   ```

2. Format it as ext4 with the label `VAULT`. This erases the drive; replace `sdb` with your device:

   ```bash
   mkfs.ext4 -L VAULT /dev/sdb
   ```

3. Install the **Samba NAS** app from `https://github.com/dianlight/hassio-addons` (**Settings → Apps → App Store → ⋮ → Repositories → + Add**) and start it. It mounts the drive at `/media/VAULT` on every boot; check under **Settings → System → Storage**.

4. Leave `vault_path` at `/media/VAULT`.

### Option B: built-in `/share`

No extra hardware or apps:

```yaml
vault_path: "/share/vault"
```

`/share` lives on the same disk or SD card as Home Assistant itself. On an SD-card Raspberry Pi, back the vault up regularly.

## First start

On the first start into a vault with no `CLAUDE.md`, the app creates:

```
/media/VAULT/
├── CLAUDE.md        # starter instructions for the agent
├── log.md           # operation log
├── raw/             # source material
│   ├── ha/
│   └── projects/
└── wiki/            # pages written by the agent
    ├── ha/
    │   ├── devices/
    │   ├── automations/
    │   └── network/
    └── projects/
```

This happens once and is remembered with the flag file `/data/.vault-structure-initialized`. A directory deleted afterwards stays deleted. A vault that already has `CLAUDE.md` is left alone, and `CLAUDE.md` and `log.md` are never overwritten. Reinstalling the app clears `/data`, but an existing `CLAUDE.md` still prevents re-seeding.

The generated `CLAUDE.md` is a minimal template. Extend it with your own devices, network, projects and rules: it is what the agent reads first.

Files can be dropped into `raw/` over the Samba share (`\\<your-ha-ip>\VAULT`) or SFTP.

## Request logging

With `log_requests: true` the auth proxy logs one line per request:

```
[req] 2026-07-13T10:56:25.478Z 160.79.106.34 POST /private_***/mcp -> 200 172B ua="Claude-User"
```

Fields: UTC timestamp, client IP (`CF-Connecting-IP`, then the first `X-Forwarded-For` address, then the socket address), method, path with the token masked as `/private_***`, status, response size in bytes, User-Agent. Requests refused with 401 or 404 are logged too, with `(unauthorized)` or `(not allowed)` appended. With the default `false` the proxy logs nothing per request. How to use this is in [troubleshooting.md](troubleshooting.md#seeing-the-requests).

## Exposing the server

claude.ai connects from the internet, so port 3100 must be reachable from outside through a reverse proxy that terminates TLS. The app speaks plain HTTP; never publish it without TLS in front. Only `/private_<token>/mcp` is served. Any other path under the prefix answers 404, and a wrong prefix 401.

Any TLS-terminating proxy works: nginx, Caddy, a Cloudflare Tunnel, or your router's own domain service. With a Keenetic router:

1. **Network rules → Port forwarding → Add rule**: incoming port `3100` → your Home Assistant IP, port `3100`.
2. **My networks and Wi-Fi → Domain name → Add**: a name such as `vault-mcp`, device → your Home Assistant server, port `3100`.

The connector URL is then:

```
https://vault-mcp.<your-keendns-domain>/private_<your-token>/mcp
```
