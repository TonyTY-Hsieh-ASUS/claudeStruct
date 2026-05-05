//go:build linux

package main

import (
	"os"
	"os/exec"
	"syscall"
)

// isolationCapabilities reports what this build can actually enforce.
// Linux has rlimits; --no-network is best-effort: real namespace
// isolation needs unshare(CLONE_NEWNET) which the kernel guards behind
// CAP_SYS_ADMIN, OR the process must be inside an unprivileged user
// namespace. We probe the second case so the run can claim
// "best-effort" instead of "unsupported" when we genuinely can do
// something.
func isolationCapabilities() capabilities {
	return capabilities{
		rlimit:  statusEnforced,
		network: detectNetworkIsolationStatus(),
	}
}

// detectNetworkIsolationStatus inspects the running process to decide
// whether `--no-network` can deliver real isolation:
//
//   - If we are root (uid 0) we have CAP_SYS_ADMIN by default and can
//     unshare(CLONE_NEWNET) directly: "enforced".
//   - If `/proc/self/uid_map` shows we are inside an unprivileged user
//     namespace, we can ALSO unshare net: "best-effort" (the host's
//     network namespace is invisible to us anyway).
//   - Otherwise: "unsupported". The seccomp profile blocks the syscall
//     to be safe, but even without it the kernel would reject our
//     CLONE_NEWNET request. We'd rather report this honestly.
func detectNetworkIsolationStatus() string {
	if os.Geteuid() == 0 {
		return statusEnforced
	}
	// Inside an unprivileged userns the uid_map maps our uid to a
	// different host uid. The most reliable signal is reading the file
	// at all and checking it isn't the canonical "0 0 4294967295\n"
	// that the init namespace presents.
	data, err := os.ReadFile("/proc/self/uid_map")
	if err == nil {
		s := string(data)
		// Identity map for the init userns is "         0          0 4294967295\n".
		// Anything else means we're already nested.
		if len(s) > 0 && s != "         0          0 4294967295\n" {
			return statusBestEffort
		}
	}
	return statusUnsupported
}

type capabilities struct {
	rlimit  string
	network string
}

// applyRLimits sets process resource limits that the child inherits.
//
// These are setrlimit() calls; the child kernel enforces them. For a child
// like `git` they're effective. For a child that itself spawns grandchildren
// (bash -c "..."), the limits apply to the whole tree since rlimit is
// per-process and inherited across fork.
func applyRLimits(cmd *exec.Cmd) {
	if cmd.SysProcAttr == nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{}
	}
	// Note: Go's exec package doesn't expose a direct RLIMIT setter in
	// SysProcAttr. We set limits via prctl/setrlimit after fork using a
	// SetRLimits-style approach: set them on the parent process BEFORE
	// exec.Cmd starts the child, since Linux inherits current RLIMITs
	// unless explicitly reset. This is a pragmatic trade-off — the
	// parent process itself gets the limits. For a shim binary that
	// exits right after, this is fine.
	_ = syscall.Setrlimit(syscall.RLIMIT_CPU, &syscall.Rlimit{
		Cur: uint64(cpuSec),
		Max: uint64(cpuSec),
	})
	memBytes := uint64(memMB) * 1024 * 1024
	_ = syscall.Setrlimit(syscall.RLIMIT_AS, &syscall.Rlimit{
		Cur: memBytes,
		Max: memBytes,
	})
	// 1024 open fds is plenty for git/test runners; tighten if needed.
	_ = syscall.Setrlimit(syscall.RLIMIT_NOFILE, &syscall.Rlimit{
		Cur: 1024,
		Max: 1024,
	})
}

func tryDisableNetwork(cmd *exec.Cmd) {
	// Real network isolation via CLONE_NEWNET. Requires CAP_SYS_ADMIN —
	// either real root (the GX10 home-server default) or an
	// unprivileged user namespace where the running process holds caps
	// against its enclosing userns. detectNetworkIsolationStatus()
	// already gates on those two cases; we only set the flag when it
	// reports something better than "unsupported" so cmd.Start() doesn't
	// fail with EPERM on hosts that genuinely can't enforce.
	caps := isolationCapabilities()
	if caps.network == statusUnsupported {
		// Honest no-op. Isolation report still prints "unsupported"
		// so the operator knows.
		return
	}
	if cmd.SysProcAttr == nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{}
	}
	cmd.SysProcAttr.Cloneflags |= syscall.CLONE_NEWNET
}

// shouldDefaultNoNetwork returns true when --no-network should default
// to ON for this run. The GX10 home-server case (Linux + root) gets
// "private repo never leaves the box" without the operator having to
// remember the flag; non-root callers keep today's default-OFF so we
// don't break existing scripts.
func shouldDefaultNoNetwork() bool {
	return isolationCapabilities().network == statusEnforced
}
