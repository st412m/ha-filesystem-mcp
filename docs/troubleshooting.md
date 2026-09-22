# Troubleshooting

Symptoms and what they mean: a stale tool list, an update the store does not show, HTTP status codes from the proxy and the server, and how to see the requests that reach the app. Start here when a connector misbehaves.

## The tool list looks wrong

After an update that adds tools or changes parameters, a client can keep showing the old list: a tool is missing, or a parameter is not offered. The server is fine; the client is working from a schema it fetched earlier.

1. Refresh the connector's tool list in the client; if the client has no refresh, remove the connector and add it again.
2. Start a new chat.

The quick test for a stale schema is `write_file`: if it has no `rev` parameter, the client is holding a schema from before 2.6.0. Do not go by the number of tools, which changes between releases.

## The store does not show a new version

Supervisor offers an update only when `version` in `filesystem_mcp/config.yaml` is higher than the installed one. It re-reads the repository periodically. To check now, open **Settings → Apps → App Store → ⋮ → Check for updates**, then reload the page.

## HTTP status codes

| Status | Where | Meaning |
|---|---|---|
| 401 | proxy | the path does not start with `/private_<token>` — wrong or missing token |
| 404 | proxy | the token is right but the path is not `/mcp`; nothing else is served |
| 405 | server | a method other than `POST` on `/mcp` (for example `GET`); the response carries `Allow: POST, OPTIONS` |
| 406 | server | the `Accept` header contains neither `application/json` nor `text/event-stream` |
| 400 | server | the request body is not valid JSON |
| 502 | proxy | the MCP server behind the proxy did not answer; check the app log |

A successful call returns 200 with `Content-Type: application/json`, not an SSE stream. A notification with no reply returns 202.

A minimal check from a machine that can reach the port:

```bash
curl -s -X POST "http://<ha-host>:3100/private_<token>/mcp" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

## Seeing the requests

Set `log_requests: true`, restart the app and watch its log. Every request that reaches the proxy produces one line:

```
[req] 2026-07-13T10:56:25.478Z 160.79.106.34 POST /private_***/mcp -> 200 172B ua="Claude-User"
```

- **Requests arrive and get 200:** the path works end to end; look at the client.
- **Requests arrive and get 401:** the token in the connector URL is wrong.
- **Nothing arrives during a connection attempt:** the requests never reach the app. Look at the reverse proxy, tunnel or port forwarding.

claude.ai connects from Anthropic's published egress range, `160.79.104.0/21`. Issue [#4](https://github.com/st412m/ha-filesystem-mcp/issues/4) shows a full investigation. Set the option back to `false` when done.

## Writes are refused

- `Refused — … is read-only by policy`: the zone is read-only. Change it on the **Vault policies** page.
- `Refused — policy "overwrite: rev"`: the file exists and the zone requires its `rev`. The message states the current `rev`; repeat the call with it.
- `rev mismatch`: the file changed since you read it. Re-read and redo the edit.
- The listing tools print `⚠ Policy: BROKEN MARKER`: a `.vault-policy` file is unreadable and locks its whole subtree. Fix it first. See [policies.md](policies.md#if-a-marker-breaks).

## The build fails

The image build runs `toolchain-check.sh build`. It stops with `TOOLCHAIN GUARD:` when Alpine ships a different major version of nodejs, poppler or sqlite3, and with `SMOKE FAIL:` when the PDF or SQLite pipeline does not work. Both print what was expected. See [internals.md](internals.md#toolchain-pinning).
