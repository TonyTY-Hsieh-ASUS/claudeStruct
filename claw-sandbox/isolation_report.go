// Structured isolation status, emitted once on startup so the caller
// can grep / parse what the sandbox is actually enforcing.
//
// The previous behavior was a single-line free-text warning printed
// only in --verbose mode (Linux) or only on non-Linux for the missing
// rlimits. Users were missing the cases that mattered most: a flag
// they passed (--no-network on Linux without CAP_SYS_ADMIN) doing
// nothing, or a different platform silently downgrading.
//
// This module emits one JSON line on stderr on every run with a
// per-control status — same shape regardless of platform. claw-squad
// (the typical caller) can capture it for its own logs / dashboard;
// humans can `grep '"event":"isolation"'`. Format intentionally
// matches the shape we'll use in W2.1 (structured logging).

package main

import (
	"encoding/json"
	"fmt"
	"os"
	"runtime"
)

// Status values used by all controls. Keep the set small so consumers
// can treat them as an enum.
const (
	statusEnforced    = "enforced"
	statusBestEffort  = "best-effort"
	statusUnsupported = "unsupported"
	statusOff         = "off"
)

// IsolationReport is the per-run summary of what each control is
// actually doing. One field per knob; values are status strings above.
//
// Fields are marshaled as JSON in the order declared, which makes the
// emitted line stable for diffing across runs.
type IsolationReport struct {
	Event          string `json:"event"`
	Platform       string `json:"platform"`
	Repo           string `json:"repo"`
	RlimitCPU      string `json:"rlimitCpu"`
	RlimitMem      string `json:"rlimitMem"`
	RlimitFds      string `json:"rlimitFds"`
	WallClockKill  string `json:"wallClockKill"`
	NoNetwork      string `json:"noNetwork"`
	EnvScrub       string `json:"envScrub"`
	PathValidation string `json:"pathValidation"`
}

// buildIsolationReport composes the per-run status. The rlimit/network
// statuses come from platform-specific files via isolationCapabilities.
func buildIsolationReport(repo string, noNetworkRequested bool) IsolationReport {
	caps := isolationCapabilities()
	r := IsolationReport{
		Event:          "isolation",
		Platform:       runtime.GOOS,
		Repo:           repo,
		RlimitCPU:      caps.rlimit,
		RlimitMem:      caps.rlimit,
		RlimitFds:      caps.rlimit,
		WallClockKill:  statusEnforced,
		EnvScrub:       statusEnforced,
		PathValidation: statusEnforced,
	}
	if !noNetworkRequested {
		r.NoNetwork = statusOff
	} else {
		r.NoNetwork = caps.network
	}
	return r
}

// emitIsolationReport writes the report to stderr as a single JSON
// line. Best-effort: marshal failure prints a fallback line so callers
// always see *something*. We don't terminate on a marshal error.
func emitIsolationReport(r IsolationReport) {
	b, err := json.Marshal(r)
	if err != nil {
		fmt.Fprintf(os.Stderr,
			"[sandbox] {\"event\":\"isolation\",\"error\":%q}\n", err.Error())
		return
	}
	fmt.Fprintf(os.Stderr, "[sandbox] %s\n", b)
}
