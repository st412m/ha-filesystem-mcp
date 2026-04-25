#!/usr/bin/with-contenv bashio

TOKEN=$(bashio::config 'token')
VAULT_PATH=$(bashio::config 'vault_path' 2>/dev/null || echo "/media/VAULT")
export VAULT_TOKEN="${TOKEN}"
export VAULT_PATH="${VAULT_PATH}"

bashio::log.info "Vault path: ${VAULT_PATH}"

bashio::log.info "Initializing vault structure..."
mkdir -p "${VAULT_PATH}/raw/ha"
mkdir -p "${VAULT_PATH}/raw/projects"
mkdir -p "${VAULT_PATH}/wiki/ha/devices"
mkdir -p "${VAULT_PATH}/wiki/ha/automations"
mkdir -p "${VAULT_PATH}/wiki/ha/network"
mkdir -p "${VAULT_PATH}/wiki/projects"

if [ ! -f "${VAULT_PATH}/CLAUDE.md" ]; then
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
fi

if [ ! -f "${VAULT_PATH}/log.md" ]; then
  bashio::log.info "Creating log.md..."
  echo "# Vault operation log" > "${VAULT_PATH}/log.md"
  echo "" >> "${VAULT_PATH}/log.md"
  echo "$(date -u +%Y-%m-%d) — vault initialized by Filesystem MCP Server addon" >> "${VAULT_PATH}/log.md"
fi

bashio::log.info "Starting Vault MCP Server v2.0 on port 3099"
node /server.js "${VAULT_PATH}" 3099 &

sleep 2

bashio::log.info "Starting auth proxy on port 3100"
node /proxy.js
