# Changelog

## 2.6.0

**Write policies.** A directory can now be marked read-only, or made to require
a file's current `rev` before anything overwrites it, and can be given a trash
instead of a delete. The rule applies to that directory and everything below it
until a deeper marker overrides it. **Nothing is switched on by an update**: a
vault with no markers behaves exactly as it did in 2.5.2. Turn strictness on
where you want it from the new **Vault policies** page — the add-on now appears
in the Home Assistant sidebar (admins only). Full documentation is on the
add-on's Documentation tab.

### Removed

- **`POST /write` is gone.** It wrote any file in the vault with no version
  check and no token of its own, and the auth proxy forwarded it straight from
  the internet, so any policy below it could be bypassed with one `curl`. If you
  used it from a `rest_command`, remove that command — there is no replacement;
  write through the MCP tools.
- The auth proxy no longer blind-forwards. Only `/mcp` is passed through;
  everything else answers 404 before reaching the server.

### Added

- `.vault-policy` markers: `readonly`, `overwrite` (`rev` / `never` / `free`),
  `trash`, `retention_enabled`, `retention_days`.
- **Vault policies** page over ingress: one level of the tree, a mode per
  directory, trash and auto-purge toggles. The only thing that writes markers.
  MCP tools refuse to create, change, move or discard a `.vault-policy` — a
  directory of that name would lock a zone with no way to repair it from the
  tool side.
- `trash_file` — the only way to remove something. The file moves into its
  zone's trash keeping its relative path, with the arrival time stamped into
  the name. Trash contents are excluded from `grep_files`, `search_files`,
  `directory_tree` and `read_multiple_files`, so discarded pages stop turning up
  in searches; they are still readable by explicit path.
- Optional auto-purge of the trash, **off by default**, per zone. It removes
  files one by one — no recursive delete anywhere — and never touches a file
  whose name has no arrival stamp, i.e. anything you dropped in over Samba.
- `write_file` and `move_file` accept `rev`. In an `overwrite: "rev"` zone,
  overwriting an existing file or moving one out of the zone requires it;
  creating a new file does not. Every refusal quotes the current `rev`, so the
  second attempt succeeds.
- `list_directory`, `list_directory_with_sizes` and `directory_tree` now print
  the rule in force and where it comes from, on every call.

### Changed

- **A deleted directory is no longer recreated on restart.** Until now six
  `mkdir -p` ran on every start, so removing `raw/projects` lasted until the
  next restart. The skeleton is created once, on a fresh install, and remembered
  with a flag in `/data`. Existing installations are detected by the presence of
  `CLAUDE.md` and are never re-seeded.
- A corrupt marker, or one with an unknown field, locks its zone: no writes, no
  deletion, reading unaffected. This is deliberate — running quietly under a
  rule nobody can read is worse than stopping. The error names the file and how
  to fix it.

Reading is unchanged. `read_text_file` without a range still returns the bare
file contents, byte for byte as in 2.5.2.
