//go:build linux

package main

import (
	"os/exec"
	"syscall"
	"testing"
)

// W10.9 wiring tests. The Go runner used by CI is non-root inside the
// init namespace on most setups, so we can't exercise the "enforced"
// CLONE_NEWNET path end-to-end here — that needs a privileged test
// environment. What we CAN lock is the dispatch logic: when the
// capability detection says "supported", `tryDisableNetwork` must
// stamp `Unshareflags |= CLONE_NEWNET` on the child's SysProcAttr;
// when "unsupported", it must leave the attr untouched.

func TestTryDisableNetwork_NoOpOnUnsupportedHost(t *testing.T) {
	// detectNetworkIsolationStatus returns statusUnsupported for the
	// non-root init-namespace case. On a CI runner that's the default;
	// the function reads /proc/self/uid_map and getuid() so we can't
	// monkey-patch it. Skip the test if we happen to be running in a
	// supported context — the intent is "never *over*-claim".
	if detectNetworkIsolationStatus() != statusUnsupported {
		t.Skipf("kernel allows unshare(CLONE_NEWNET); covered by the supported-path test")
	}
	cmd := exec.Command("/bin/true")
	tryDisableNetwork(cmd)
	if cmd.SysProcAttr != nil && cmd.SysProcAttr.Unshareflags&syscall.CLONE_NEWNET != 0 {
		t.Errorf("expected CLONE_NEWNET to NOT be set on unsupported host; got Unshareflags=%#x",
			cmd.SysProcAttr.Unshareflags)
	}
}

func TestTryDisableNetwork_SetsCloneNewnetWhenSupported(t *testing.T) {
	if detectNetworkIsolationStatus() == statusUnsupported {
		t.Skipf("running unprivileged in init namespace; skip the supported-path assertion")
	}
	cmd := exec.Command("/bin/true")
	tryDisableNetwork(cmd)
	if cmd.SysProcAttr == nil {
		t.Fatal("expected SysProcAttr to be initialized")
	}
	if cmd.SysProcAttr.Unshareflags&syscall.CLONE_NEWNET == 0 {
		t.Errorf("expected CLONE_NEWNET in Unshareflags=%#x", cmd.SysProcAttr.Unshareflags)
	}
}

func TestTryDisableNetwork_PreservesOtherUnshareflags(t *testing.T) {
	// Defensive: callers that pre-set other unshare flags (e.g. an
	// outer CLONE_NEWPID) must keep their bits when we OR in NEWNET.
	if detectNetworkIsolationStatus() == statusUnsupported {
		t.Skip("supported-path test")
	}
	cmd := exec.Command("/bin/true")
	cmd.SysProcAttr = &syscall.SysProcAttr{
		Unshareflags: syscall.CLONE_NEWPID,
	}
	tryDisableNetwork(cmd)
	got := cmd.SysProcAttr.Unshareflags
	if got&syscall.CLONE_NEWPID == 0 {
		t.Errorf("CLONE_NEWPID lost: %#x", got)
	}
	if got&syscall.CLONE_NEWNET == 0 {
		t.Errorf("CLONE_NEWNET not added: %#x", got)
	}
}
