# Install

Pick the tool you want; they install independently.

## `cs` (claudestruct)

=== "pip (development)"

    ```bash
    git clone https://github.com/tonyandclaw/claudeStruct.git
    cd claudeStruct
    pip install -e .
    export ANTHROPIC_API_KEY=sk-ant-...
    cs dev "your task"
    ```

=== "Docker"

    ```bash
    docker run --rm \
      -e ANTHROPIC_API_KEY \
      -v "$PWD:/workspace" \
      ghcr.io/tonyandclaw/claudestruct:latest \
      dev "your task"
    ```

`cs --help` shows every flag. The CLI is one-shot: it gathers context, calls
Claude once, prints the response, exits.

## `claw-squad`

```bash
cd claw-squad
pnpm install        # or: npm install
pnpm build
node dist/cli.js run "your requirement"
```

Configuration lives in `.claw-squad/config.json` (zod-validated). The
[Providers](claw-squad/providers.md) doc covers swapping the model backend.

## `claw-sandbox`

```bash
cd claw-sandbox
go build -o claw-sandbox .
```

Used by `claw-squad --sandbox`. Its isolation guarantees vary by platform —
on Linux rlimits are enforced, but `--no-network` requires `CAP_SYS_ADMIN`.
Run inside Docker or firejail for stronger guarantees.

## Requirements

| Tool          | Runtime                   |
| ------------- | ------------------------- |
| `cs`          | Python ≥ 3.10             |
| `claw-squad`  | Node ≥ 20                 |
| `claw-sandbox`| Go ≥ 1.22 (build only)    |

The combined Docker image bundles all three.
