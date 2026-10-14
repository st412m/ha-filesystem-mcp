#!/usr/bin/with-contenv bashio
# shellcheck shell=bash
# App options -> environment and /data/everkeep.json, the vault skeleton on the
# first start, the token, then Everkeep: MCP on port 3100, the Vault policies
# page on port 3101 (ingress).

EVERKEEP_PKG=/opt/everkeep/node_modules/everkeep

VAULT_PATH=$(bashio::config 'vault_path' '/media/VAULT')
# Empty when the option is empty or absent.
TOKEN=$(bashio::config 'token')
if [ "${TOKEN}" = "null" ]; then TOKEN=""; fi

# Everkeep takes the vault and its state directory from the environment and
# the rest from a config file written on every start. The token never goes
# into the file.
export EVERKEEP_VAULT="${VAULT_PATH}"
export EVERKEEP_STATE_DIR=/data
export EVERKEEP_CONFIG=/data/everkeep.json
jq '{
  log_requests: (.log_requests == true),
  policy_page: {mode: "ha-ingress", port: 3101, users: (.policy_page_users // [])}
}' /data/options.json > "${EVERKEEP_CONFIG}"

# Toolchain versions and the build manifest (versions and smoke test result)
# go to the log at start: the container has no shell to read /toolchain.txt.
RUNTIME=$(sh "${EVERKEEP_PKG}/scripts/toolchain-check.sh" runtime)
EVERKEEP_VERSION=${RUNTIME#everkeep }
EVERKEEP_VERSION=${EVERKEEP_VERSION%% *}
bashio::log.info "Toolchain: ${RUNTIME}"
if [ -f /toolchain.txt ]; then
    bashio::log.info "Build manifest: $(tr '\n' ';' < /toolchain.txt | sed 's/;/; /g')"
fi
bashio::log.info "Filesystem MCP Server ${APP_VERSION} (everkeep ${EVERKEEP_VERSION})"

bashio::log.info "Vault path: ${VAULT_PATH}"

# The vault skeleton is created once per installation, guarded by a flag in
# /data that survives a container restart but not a reinstall. A vault that
# already has CLAUDE.md is never seeded: the flag is just set, and a
# directory deleted later stays deleted.
INIT_FLAG="/data/.vault-structure-initialized"

if [ -f "${INIT_FLAG}" ]; then
  bashio::log.info "Vault structure: already initialized, leaving the tree alone"
elif [ -f "${VAULT_PATH}/CLAUDE.md" ]; then
  bashio::log.info "Vault structure: existing vault detected (CLAUDE.md present) — not recreating directories"
  touch "${INIT_FLAG}"
else
  bashio::log.info "Initializing vault structure (first run)..."
  mkdir -p "${VAULT_PATH}/raw/ha"
  mkdir -p "${VAULT_PATH}/raw/projects"
  mkdir -p "${VAULT_PATH}/wiki/ha/devices"
  mkdir -p "${VAULT_PATH}/wiki/ha/automations"
  mkdir -p "${VAULT_PATH}/wiki/ha/network"
  mkdir -p "${VAULT_PATH}/wiki/projects"

  bashio::log.info "Creating CLAUDE.md..."
  cat > "${VAULT_PATH}/CLAUDE.md" << 'CLAUDEMD'
# CLAUDE.md — Agent Instructions

## What this is
A personal wiki knowledge base using the Karpathy LLM wiki pattern.
The LLM reads and writes files, the human curates sources and asks questions.

## Vault structure

VAULT/
├── CLAUDE.md         # this file — read first
├── log.md            # append-only operation log
├── raw/              # raw source material — do not edit, only read
│   ├── ha/
│   └── projects/
└── wiki/             # LLM-compiled pages
    ├── ha/
    │   ├── devices/      # one file per device or device group
    │   ├── automations/  # one file per automation
    │   └── network/      # addons, integrations, network config
    └── projects/         # project subdirs added as needed

## Rules

1. Read CLAUDE.md first in every chat before working with the vault
2. Write to wiki/ only — never modify raw/
3. Log every operation in log.md: [date] action
4. One file = one entity (device, automation, service, project)
5. Use wikilinks between files: [[filename]]
6. Never delete existing content — only append or update
7. If a device or topic does not fit existing categories — create a new subfolder

## Operations

/ingest — Read raw/, compile into wiki/, update related pages, write to log.md
/query  — Read relevant wiki/ files, answer with references to sources
/lint   — Find: broken links, stale data, contradictions, orphan pages
/update — Update a specific file with new data, preserve change history

## MCP servers available to agent
- **HA-MCP** — Home Assistant entities, automations, addons
- **Keenetic-MCP** — router: clients, DHCP, Wi-Fi, VPN
- **Vault-MCP** — read/write files in this vault
CLAUDEMD

  bashio::log.info "Creating log.md..."
  echo "# Vault operation log" > "${VAULT_PATH}/log.md"
  echo "" >> "${VAULT_PATH}/log.md"
  echo "$(date -u +%Y-%m-%d) — vault initialized by Filesystem MCP Server addon" >> "${VAULT_PATH}/log.md"

  touch "${INIT_FLAG}"
fi

# Token. An empty option means Everkeep's own token in /data/token: generated
# when there is none, then written into the option, so it shows on the
# Configuration tab. "changeme", the 2.x default, counts as empty. Any other
# value is used as given; one that breaks the Everkeep token rules (from 2.x)
# is accepted through EVERKEEP_ALLOW_LEGACY_TOKEN, and everkeep warns about it
# on every start.
TOKEN_FILE=/data/token
# Present once the token of /data/token is in the option: an empty option after
# that means the field was cleared for a new token. /data/token without it
# means the write into the option failed: the token is kept and the write is
# tried again.
TOKEN_SAVED=/data/.token-in-option

# Through the Supervisor API (/addons/self/options needs no hassio_api),
# checked by reading the option back: the return code of bashio::addon.option
# does not carry the API result. Its stdout is an empty line; errors still
# reach the log (bashio logs to its own descriptor).
save_token_option() {
    bashio::addon.option 'token' "${1}" > /dev/null || true
    [ "$(bashio::addon.options | jq -r '.token // empty')" = "${1}" ]
}

# "changeme" has its own warning; the "cleared" one would be false then.
CHANGEME=false
if [ "${TOKEN}" = "changeme" ]; then
    bashio::log.warning "token: the option held \"changeme\", the 2.x default; a generated token replaces it, so the connector URL changes: update it in every client"
    TOKEN=""
    CHANGEME=true
fi

if [ -n "${TOKEN}" ]; then
    export EVERKEEP_TOKEN="${TOKEN}"
    export EVERKEEP_ALLOW_LEGACY_TOKEN=1
else
    if [ -f "${TOKEN_FILE}" ] && [ ! -f "${TOKEN_SAVED}" ]; then
        bashio::log.info "token: using ${TOKEN_FILE}, not in the token option yet"
    else
        if [ -f "${TOKEN_SAVED}" ] && [ "${CHANGEME}" = false ]; then
            bashio::log.warning "token: the option was cleared: a new token replaces the old one, so the connector URL changes: update it in every client"
        fi
        # Generated by everkeep (32 random bytes, mode 0600). stdout: the
        # connector path, then the Bearer line; shown here once.
        if ! LINES=$(everkeep token --new 2>/tmp/everkeep-token.err); then
            bashio::log.error "token: $(cat /tmp/everkeep-token.err)"
            bashio::exit.nok
        fi
        rm -f "${TOKEN_SAVED}"
        bashio::log.info "token: new token generated and saved to ${TOKEN_FILE}"
        bashio::log.info "claude.ai connector path: ${LINES%%$'\n'*}"
        bashio::log.info "Bearer header: ${LINES#*$'\n'}"
    fi
    if save_token_option "$(cat "${TOKEN_FILE}")"; then
        touch "${TOKEN_SAVED}"
        bashio::log.info "token: saved in the token option (Configuration tab)"
    else
        SLUG=$(hostname | tr '-' '_')
        bashio::log.warning "token: the token option could not be written; the token stays in ${TOKEN_FILE} and is used from there, and the next start tries again. To show it, on the host: docker exec app_${SLUG} everkeep token (container addon_${SLUG} with an older Supervisor)"
    fi
fi

bashio::log.info "Starting everkeep: MCP on port 3100, Vault policies page on port 3101 (ingress)"
exec everkeep serve --host 0.0.0.0 --port 3100
