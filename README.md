# Filesystem MCP Server — Home Assistant App

A Home Assistant app that runs [Everkeep](https://github.com/st412m/everkeep) on your Home Assistant server: one folder (the "vault") under `/media` or `/share` that Claude and other AI clients read and edit through the [Model Context Protocol](https://modelcontextprotocol.io), under write policies you set on the **Vault policies** page in the sidebar. The tools read, search and edit text files, read PDF, Word, Excel and other documents, and query SQLite databases read-only. Drop contracts, invoices or manuals into the vault as they are, and the assistant searches all of them at once and tells you the file and the page where it found the answer.

Home Assistant's built-in MCP Server integration exposes entities and Assist. This app exposes files instead, and the two work side by side.

## Requirements

| | |
|---|---|
| Home Assistant | OS or Supervised — anything that runs apps through Supervisor |
| Architecture | amd64, aarch64 (Raspberry Pi 4/5) |
| Network | port 3100/tcp; for claude.ai, a public HTTPS address in front of it |
| Storage | a directory under `/media` (for example a USB drive) or `/share` |

## Installation

From Home Assistant 2026.2 the menus say *Apps* and *App Store*; older versions say *Add-ons* and *Add-on Store*.

**1. Add this repository**

[![Open your Home Assistant instance and show the add app repository dialog with a specific repository URL pre-filled.](https://my.home-assistant.io/badges/supervisor_add_addon_repository.svg)](https://my.home-assistant.io/redirect/supervisor_add_addon_repository/?repository_url=https%3A%2F%2Fgithub.com%2Fst412m%2Fha-filesystem-mcp)

Or by hand: **Settings → Apps → App Store → ⋮ → Repositories → + Add**, paste `https://github.com/st412m/ha-filesystem-mcp`, select **Add**.

*If the badge opens the App Store but no dialog appears, use the manual path.*

**2. Install and configure**

Find **Filesystem MCP Server** in the store and select **Install**. In **Configuration**, point `vault_path` at your vault and leave `token` empty.

**3. Start**

Select **Start**. On the first start the app generates a token, writes it into the `token` field and shows the connector path once in the log. Into a vault without `CLAUDE.md` it also creates a starter `CLAUDE.md`, `log.md` and a small `raw/` + `wiki/` skeleton, once.

## Configuration

| Option | Default | Description |
|---|---|---|
| `token` | empty | Empty: the app generates a token and saves it here. Clear it and restart for a new one. |
| `vault_path` | `/media/VAULT` | The one directory the server may touch — anywhere under `/media` or `/share`. |
| `log_requests` | `false` | Log one line per request (token masked) for debugging connectors. |
| `policy_page_users` | `[]` | Home Assistant users allowed to open the Vault policies page, by user name or user ID. Empty: every Home Assistant user. |

## Connecting

- **claude.ai and the Claude apps:** `https://<your-host>/private_<token>/mcp` as a custom connector (**Settings → Connectors → Add custom connector**). claude.ai connects from the internet, so port 3100 must be reachable through HTTPS: a tunnel or a reverse proxy, see [remote access](https://github.com/st412m/everkeep/blob/main/docs/remote-access.md).
- **Claude Code, Cursor and other clients:** `http://<ha-host>:3100/mcp` with the header `Authorization: Bearer <token>`.

The token is a password: anyone who has it can read and change the vault.

## Documentation

- [App documentation](filesystem_mcp/DOCS.md) — options, connecting, the Vault policies page, upgrading from 2.x
- [Everkeep documentation](https://github.com/st412m/everkeep/tree/main/docs) — tools, write policies, documents, SQLite, security, troubleshooting
- [Changelog](filesystem_mcp/CHANGELOG.md)

## Reporting problems

- Installing or updating the app, its options, the token field, the Vault policies page in the sidebar: [issues of this repository](https://github.com/st412m/ha-filesystem-mcp/issues).
- The tools, write policies, documents, SQLite: [Everkeep issues](https://github.com/st412m/everkeep/issues).

If unsure, open it here.

## License

[MIT](LICENSE)
