//go:build !linux

package main

import (
	"os/exec"
)

// On non-Linux platforms rlimit semantics differ. The structured
// isolation report (printed at startup) carries the "unsupported"
// status so callers know without parsing free-text warnings.
func applyRLimits(_ *exec.Cmd) {}

func tryDisableNetwork(_ *exec.Cmd) {}

// shouldDefaultNoNetwork: never on non-Linux. CLONE_NEWNET doesn't
// exist on macOS / Windows; the existing best-practice (run inside a
// VM / container) covers those hosts.
func shouldDefaultNoNetwork() bool { return false }

// isolationCapabilities reports what this build can actually enforce.
// Non-Linux: rlimits + namespace network isolation are both off.
func isolationCapabilities() capabilities {
	return capabilities{
		rlimit:  statusUnsupported,
		network: statusUnsupported,
	}
}

type capabilities struct {
	rlimit  string
	network string
}
