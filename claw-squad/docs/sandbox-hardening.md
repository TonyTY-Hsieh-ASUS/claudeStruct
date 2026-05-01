# Sandbox hardening

The Go sandbox (`claw-sandbox`) ships three layers of defense in depth:

1. **rlimits + path validation + env scrubbing** — built-in to the binary; always on. Documented in [`claw-squad/README.md`](../README.md).
2. **Seccomp profile** ([`claw-sandbox/seccomp.json`](../../claw-sandbox/seccomp.json)) — kernel-level syscall filter. Blocks ptrace, module loading, mount/pivot_root, kexec, setuid escalation, hostname/clock control, ioperm, bpf, namespace creation, swap toggling, kernel keyring + audit. **Off by default**; opt in via Docker / containerd.
3. **AppArmor profile** ([`claw-sandbox/apparmor.profile`](../../claw-sandbox/apparmor.profile)) — filesystem-access mediation. Allows reads in `/usr/lib`, `/lib`, the workspace, and standard `/proc/self`; denies `/etc/shadow`, `/root`, `~/.ssh`, `~/.aws/credentials`, `~/.config/gh`, `/dev/{mem,kmem,port}`, `/sys/kernel/{debug,tracing}`. **Off by default** unless loaded into the host's AppArmor namespace.

> **Threat model**: a Coder agent generating shell commands to drive `npm test` / `pytest` / `git commit` should succeed; the same agent attempting to load a kernel module, read `/etc/shadow`, or call `unshare(CLONE_NEWNS)` to nest a container should fail closed. Skills / multi-agent loops are LLM-driven and therefore untrusted code in the strict sense; the sandbox treats them that way.

## Recipes

### Docker — both profiles applied

```bash
# Build the sandbox-aware image (your repo's Dockerfile + the profiles).
docker run --rm \
  --security-opt seccomp=claw-sandbox/seccomp.json \
  --security-opt apparmor=claw-sandbox \
  --read-only \
  --tmpfs /tmp:rw,exec,size=512m \
  --tmpfs /var/tmp:rw,exec,size=128m \
  -v "$(pwd):/workspace:rw" \
  -w /workspace \
  -e ANTHROPIC_API_KEY \
  ghcr.io/tonyandclaw/claudestruct:latest \
  cs review
```

Notes:
- `--read-only` plus the `tmpfs` mounts give the toolchain a writable scratch area without making the rootfs writable. Most modern build systems work fine with this.
- `--security-opt apparmor=claw-sandbox` references the loaded profile name; load the file once on the host with `sudo apparmor_parser -r -W claw-sandbox/apparmor.profile`.
- Drop `--cap-drop=ALL` if you can — most Coder workloads don't need any capabilities once seccomp is in place.

### firejail — quick single-command harness

For developers who want sandbox protections without Docker:

```bash
firejail \
  --seccomp.drop=ptrace,init_module,finit_module,delete_module,kexec_load,kexec_file_load,reboot,mount,umount,umount2,pivot_root,chroot,unshare,setns \
  --read-only=/ \
  --read-write="$(pwd)" \
  --private-tmp \
  --net=none \
  -- cs review
```

`firejail` doesn't read the seccomp.json directly, so we transcribe the same syscall denylist via `--seccomp.drop`. `--net=none` is the closest equivalent to the missing `--no-network`; it requires firejail's setuid wrapper, which is the default install on most distros.

### Kubernetes — PodSecurityPolicy / SeccompProfile

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: cs-review
spec:
  securityContext:
    runAsNonRoot: true
    runAsUser: 65532
    seccompProfile:
      type: Localhost
      localhostProfile: claw-sandbox/seccomp.json
  containers:
    - name: cs
      image: ghcr.io/tonyandclaw/claudestruct:latest
      command: ["cs", "review"]
      securityContext:
        readOnlyRootFilesystem: true
        capabilities:
          drop: ["ALL"]
        appArmorProfile:
          type: Localhost
          localhostProfile: claw-sandbox
      resources:
        limits:
          cpu: "2"
          memory: "1Gi"
```

`seccompProfile.localhostProfile` is the path under each kubelet's `--seccomp-default-profiles-dir` (default `/var/lib/kubelet/seccomp/`). Same idea for AppArmor.

## Network isolation

`--no-network` now delivers real `CLONE_NEWNET` isolation on Linux when the running process holds `CAP_SYS_ADMIN` (real root, or already inside an unprivileged user namespace). On those hosts the flag also defaults to ON — the GX10 home-server case (Linux + root + always-on `claudestruct-worker.service`) gets "private repo never leaves the box" without the operator remembering the flag.

| Host configuration                                  | `noNetwork` field in isolation report | Default for `--no-network` |
|-----------------------------------------------------|---------------------------------------|----------------------------|
| Linux + root (GX10, dedicated worker, CI runner)    | `enforced`                            | **on**                     |
| Linux + unprivileged userns (rootless container)    | `best-effort`                         | off (operator opts in)     |
| Linux + non-root, init userns                       | `unsupported`                         | off                        |
| macOS / Windows                                     | `unsupported`                         | off                        |

Workflows that need outbound network (`npm install`, `pip install`, fetching submodules) should pass `--allow-network` to opt out of the auto-on default. The CLI also accepts the explicit `--no-network` for hosts that haven't been auto-detected — the kernel decides whether the request actually lands and the isolation report records the resulting status.

`--no-network` does not replace network-layer defence-in-depth:

- Docker: `--network=none` or a dedicated bridge with egress rules
- Kubernetes: a `NetworkPolicy` denying egress except to `api.anthropic.com:443`
- firejail: `--net=none`
- VPN / corporate firewall: standard egress allowlist

The sandbox's job is to fence off process-level escape; the network layer's job is to fence off data exfiltration. `--no-network` covers a meaningful slice of the second job on Linux+root; treat it as additive, not as a substitute for outer isolation.

## What the profiles do NOT cover

- **GPU access**. If you map `/dev/nvidia*` into the sandbox for an agent that wants CUDA, the device-file allow rules need extending in the AppArmor profile.
- **Container nested in container**. The seccomp denylist explicitly blocks `unshare`/`setns`, so you can't run `docker` inside the sandbox even on Linux. This is intentional — the LLM should drive the outer Docker, not the inner one.
- **Side channels**. Spectre-class CPU vulns are mitigated at the host level (microcode + kernel patches), not at the sandbox boundary. If the threat model includes those, run the sandbox in a dedicated VM, not just a container.
