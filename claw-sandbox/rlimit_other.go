//go:build !linux

package main

import (
	"fmt"
	"os"
	"os/exec"
)

// On non-Linux platforms rlimit semantics differ. Print a warning once
// so users know sandboxing is not enforced and continue without isolation.
func applyRLimits(_ *exec.Cmd) {
	fmt.Fprintln(os.Stderr, "[sandbox] warning: rlimit enforcement only implemented on Linux; running without isolation")
}

func tryDisableNetwork(_ *exec.Cmd) {
	fmt.Fprintln(os.Stderr, "[sandbox] warning: --no-network only implemented on Linux")
}
