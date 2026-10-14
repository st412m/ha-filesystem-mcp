# Filesystem MCP Server

Runs [Everkeep](https://github.com/st412m/everkeep), an MCP server that gives an AI assistant read and write access to one directory tree, the "vault", under write policies it cannot change: text, documents and PDFs, regex search, line edits guarded by `rev`, read-only SQLite. Put contracts, invoices, manuals and spreadsheets into the vault as they are — PDF, Word, Excel, e-mails — and the assistant reads and searches them and says on which page it found the answer. This page covers running the app. The full reference is in the [Everkeep documentation](https://github.com/st412m/everkeep/tree/main/docs).

## Options

| Option | Default | What it does |
|---|---|---|
| `token` | empty | The secret in the connector URL. Leave it empty: the app generates one. |
| `vault_path` | `/media/VAULT` | The one directory the server may touch, under `/media` or `/share`. |
| `log_requests` | `false` | Log every request (method, path with the token masked, status, bytes, `MCP-Protocol-Version` header, user agent). |
| `policy_page_users` | `[]` | Home Assistant users allowed to open the Vault policies page, by user name or user ID. Empty: every Home Assistant user. |

Restart the app after changing an option, then reload the Configuration tab and check that the value stayed: an option that was typed but not saved looks the same until then. The start line in the log shows the vault in force: `everkeep 1.0.0 on 0.0.0.0:3100, vault /media/VAULT, …`.

## The token

- **Empty field:** on the next start the app generates a token, writes it into the field and shows the connector path and the Bearer line once in the log.
- **New token:** clear the field and restart. The connector URL changes: update it in every client.
- **Your own token** must be at least 32 characters of `A-Z a-z 0-9 . _ ~ -`.
- **A token from 2.x:** `changeme` is replaced with a generated token on the first start of 3.0 (the log warns; the connector URL changes). A shorter token or one with other characters keeps working, with a warning in the log on every start; clear the field to get a generated one.

If the app cannot write the field, the token stays in the app's data and the log says so.

## Connecting

The server listens on port 3100.

- **claude.ai and the Claude apps:** add a custom connector (**Settings → Connectors → Add custom connector**) with `https://<your-host>/private_<token>/mcp`. claude.ai connects from the internet, so publish port 3100 through a tunnel or a reverse proxy that terminates TLS; never without TLS. See [remote access](https://github.com/st412m/everkeep/blob/main/docs/remote-access.md).
- **Claude Code, Cursor and other clients:** `http://<ha-host>:3100/mcp` with the header `Authorization: Bearer <token>`.

A wrong path or token gets an empty 404, a wrong Bearer token 401.

## Where to put the vault

The app maps `/media` and `/share` read-write. To put files into the vault from your computer, use the Home Assistant Samba share app: the vault is the folder named in `vault_path` inside its share `media` or `share` ([putting your files in](https://github.com/st412m/everkeep/blob/main/docs/your-files.md#home-assistant)). A USB drive formatted as ext4 appears under `/media` once mounted (for example by the Samba NAS app); `/share` lives on the same disk as Home Assistant itself. A drive formatted as exFAT or NTFS works too: Everkeep keeps its policies on file systems that ignore letter case.

## Fresh install

On the first start into a vault without `CLAUDE.md`, the app creates `raw/ha`, `raw/projects`, `wiki/ha/{devices,automations,network}`, `wiki/projects`, a starter `CLAUDE.md` and `log.md`. This happens once. A directory deleted afterwards stays deleted, and an existing vault is never re-seeded.

## Vault policies page

With no policies, any tool may write anywhere in the vault. To restrict a directory, open **Vault policies** in the sidebar and choose a mode for it. The rule applies to the directory and everything below it until a deeper marker overrides it.

| Mode | Effect |
|---|---|
| inherits | no marker here; the rule from above applies |
| read-only | no writes, edits, moves in or out, or discards; reading is unaffected |
| edits with rev | new files are free; changing, moving out or discarding an existing file requires its current `rev` |
| free writes | no checks |
| new files only | existing files may not be changed |

A directory saved below one that has a trash shares that trash; the page shows which one. Auto-purge erases files older than the set number of days from a zone's trash, shortly after start and then daily.

**A broken marker locks its zone.** A `.vault-policy` that is not valid JSON, or carries a field the app does not know, stops all writes and deletion in its whole subtree. Reading keeps working, and the listing tools print `⚠ Policy: BROKEN MARKER`. Fix the marker on the page, or the file on disk.

Home Assistant shows the Vault policies entry in the sidebar to administrators only, but serves the page itself to any logged-in user who opens its address. To restrict it, list your user name (Settings → People → Users; the Users tab is shown only with Advanced mode turned on in your user profile) in `policy_page_users`; any other user gets 403.

Policies stop the app's tools only. Samba, the file editor or a `shell_command` write straight to the filesystem and never see a marker.

More: [write policies](https://github.com/st412m/everkeep/blob/main/docs/policies.md).

## Upgrading from 2.x

- The connector URL stays the same unless the token was `changeme`.
- The 20 tools keep their names; existing markers and trash keep working; the vault is not seeded again.
- New: documents (PDF, Word, Excel and more) read as text, `Authorization: Bearer` as a second way in, refusals that name the policy editor instead of Samba.
- After the update, refresh the connector's tool list in the client and start a new chat.

## Backups

Home Assistant backups of the app include the token and settings, not the document cache, which is rebuilt when needed.

## Links

- [Everkeep documentation](https://github.com/st412m/everkeep/tree/main/docs): [tools](https://github.com/st412m/everkeep/blob/main/docs/tools.md), [documents](https://github.com/st412m/everkeep/blob/main/docs/documents.md), [sqlite](https://github.com/st412m/everkeep/blob/main/docs/sqlite.md), [security](https://github.com/st412m/everkeep/blob/main/docs/security.md), [troubleshooting](https://github.com/st412m/everkeep/blob/main/docs/troubleshooting.md)
- [Changelog](https://github.com/st412m/ha-filesystem-mcp/blob/main/filesystem_mcp/CHANGELOG.md)
- [License (MIT)](https://github.com/st412m/ha-filesystem-mcp/blob/main/LICENSE)
