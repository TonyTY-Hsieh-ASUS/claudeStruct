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

// tryDisableNetwork attaches CLONE_NEWNET to the child via SysProcAttr
// when the kernel will let us — real network isolation, not a no-op
// (W10.9). Three branches:
//
//  1. Root (CAP_SYS_ADMIN): unshare(CLONE_NEWNET) succeeds; the child
//     boots into a fresh network namespace with no interfaces beyond
//     loopback. detectNetworkIsolationStatus() already returns
//     "enforced" for this case so the structured isolation report
//     matches what the kernel will actually do.
//
//  2. Non-root inside an unprivileged user namespace: also allowed —
//     the child's network surface is whatever the parent userns can
//     see, which is typically already isolated from the host.
//     "best-effort".
//
//  3. Non-root in the init namespace: CLONE_NEWNET would EPERM. Skip
//     attaching it; the isolation report has already declared
//     "unsupported" so the caller knows what they got.
//
// Setting `Unshareflags` here means the *child* (the user's command)
// runs in the new netns. The parent stays in the host network so we
// can still read /proc/self/uid_map etc. for the report.
func tryDisableNetwork(cmd *exec.Cmd) {
	status := detectNetworkIsolationStatus()
	if status == statusUnsupported {
		// Honest no-op: the kernel would reject the unshare request
		// anyway. The isolation report's noNetwork field already
		// surfaced "unsupported" so the caller has been warned.
		return
	}

	if cmd.SysProcAttr == nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{}
	}
	// CLONE_NEWNET cuts the child off from the host's network
	// namespace. The Go exec package handles the unshare() call
	// post-fork-pre-exec for us.
	cmd.SysProcAttr.Unshareflags |= syscall.CLONE_NEWNET
}
