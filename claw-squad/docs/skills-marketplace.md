# Skills marketplace (W7.3)

The local skills loader ([`skills.ts`](https://github.com/tonyandclaw/claudeStruct/blob/main/claw-squad/src/skills.ts)) reads
`.claw-squad/skills/*.md` already committed to the repo. The
**marketplace** is the layer above: fetching skills from a remote
source and installing them into that directory, with a content-addressed
integrity check so a tampered hosting layer can't silently swap a
skill body underneath you.

## CLI

```bash
# List installed skills + their manifest metadata.
claw-squad skills list

# Install by id from the default registry.
claw-squad skills install python-testing

# Install from a specific registry.
claw-squad skills install python-testing \
  --registry https://internal.example.com/skills/index.json

# Install from a manifest URL directly.
claw-squad skills install https://example.com/python-testing.json

# Install from a local manifest (air-gapped).
claw-squad skills install file:///srv/claw-skills/python-testing.json

# Remove a skill (and its sidecar manifest).
claw-squad skills uninstall python-testing
```

The default registry URL is `https://skills.claudestruct.dev/index.json`;
override per-invocation with `--registry`, or globally with the
`CLAW_SKILLS_REGISTRY` env var.

## Manifest format

One JSON file per skill, served alongside the `.md`:

```json
{
  "id": "python-testing",
  "version": "1.2.0",
  "description": "When writing pytest tests; covers fixtures, parametrize, mocking",
  "url": "https://skills.claudestruct.dev/python-testing-1.2.0.md",
  "sha256": "abcd1234...",
  "applyTo": ["test_*.py", "*_test.py", "tests/**"],
  "license": "MIT",
  "homepage": "https://github.com/...",
  "publishedAt": "2026-04-26T12:00:00Z"
}
```

| Field         | Required | Notes                                                   |
| ------------- | -------- | ------------------------------------------------------- |
| `id`          | yes      | stable identifier; lowercase + hyphens                  |
| `version`     | yes      | semver string (compared as a string for v1)             |
| `description` | yes      | one-liner shown in Planner's catalog turn               |
| `url`         | yes      | https / file:// URL of the `.md` body                   |
| `sha256`      | yes      | 64-hex SHA-256 of the `.md` body bytes                  |
| `applyTo`     | no       | picomatch globs (auto-activate the skill)               |
| `license`     | no       | SPDX identifier                                         |
| `homepage`    | no       | source repo / docs link                                 |
| `publishedAt` | no       | ISO-8601 timestamp                                      |

## Registry index

A registry serves a single JSON document at a stable URL. Two shapes
are accepted:

```json
[ {manifest1}, {manifest2}, ... ]
```

or

```json
{ "manifests": [ {manifest1}, {manifest2}, ... ] }
```

Invalid manifests are dropped with a warning; the rest still load. A
registry that 5xx's surfaces as a hard error so users don't silently
get a stale catalog.

## Sha256 verification

`installSkill()` fetches the `.md` body, hashes it, and compares
against `manifest.sha256`. **A mismatch refuses the install** —
silent corruption would defeat the whole point. The error message
includes both hashes so the user can decide whether the manifest is
stale or the host has been tampered with.

The sha256 check defends against:

- a hosting layer (CDN, mirror, S3) being compromised
- a stale URL serving the wrong file
- typo'd or rewritten manifests

It does **not** defend against:

- a compromised registry index that swaps in a malicious manifest
  with a matching hash (you trust the registry author's PGP key
  out-of-band; cosign signatures are a future addition above this
  layer)

## Sidecar manifest

After install, `<id>.md.manifest.json` lives next to the `.md`. This
keeps provenance (version, source URL, hash) inspectable without
re-fetching, and lets `claw-squad skills list` show
`python-testing v1.2.0` instead of just the file name.

## Air-gapped use

Set `CLAW_SKILLS_REGISTRY=file:///srv/claw-skills/index.json` and host
the index + skill bodies on a local file server or mounted share. The
sha256 check works the same — clone-by-rsync, scan, install, ship.
