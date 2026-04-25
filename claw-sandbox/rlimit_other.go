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
