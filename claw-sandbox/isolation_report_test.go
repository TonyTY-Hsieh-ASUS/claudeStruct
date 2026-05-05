package main

import (
	"encoding/json"
	"runtime"
	"testing"
)

// Lock the structured isolation stanza: it carries the "what is
// actually being enforced" promise the README makes, so we want a
// regression test on the JSON shape, not just the values.

func TestBuildIsolationReport_SetsExpectedFields(t *testing.T) {
	r := buildIsolationReport("/tmp/repo", true)
	if r.Event != "isolation" {
		t.Errorf("event=%q want %q", r.Event, "isolation")
	}
	if r.Platform != runtime.GOOS {
		t.Errorf("platform=%q want %q", r.Platform, runtime.GOOS)
	}
	if r.Repo != "/tmp/repo" {
		t.Errorf("repo=%q", r.Repo)
	}
	if r.WallClockKill != statusEnforced {
		t.Errorf("wallClockKill=%q want enforced", r.WallClockKill)
	}
	if r.EnvScrub != statusEnforced {
		t.Errorf("envScrub=%q want enforced", r.EnvScrub)
	}
	if r.PathValidation != statusEnforced {
		t.Errorf("pathValidation=%q want enforced", r.PathValidation)
	}
}

func TestBuildIsolationReport_NoNetworkOffWhenFlagAbsent(t *testing.T) {
	r := buildIsolationReport("/tmp/repo", false)
	if r.NoNetwork != statusOff {
		t.Errorf("noNetwork with flag=false should be %q, got %q", statusOff, r.NoNetwork)
	}
}

func TestBuildIsolationReport_NoNetworkReflectsCapability(t *testing.T) {
	r := buildIsolationReport("/tmp/repo", true)
	// Linux: depends on whether the test runner is root (enforced),
	// inside an unprivileged userns (best-effort), or in the init
	// namespace as non-root (unsupported). Other OSes are always
	// unsupported. We just lock the value to one of the recognized
	// strings so a regression that drops the field caught instantly.
	switch r.NoNetwork {
	case statusEnforced, statusBestEffort, statusUnsupported:
		// ok
	default:
		t.Errorf("noNetwork=%q is not one of the recognized status values", r.NoNetwork)
	}
}

func TestIsolationReport_JSONShapeStable(t *testing.T) {
	r := buildIsolationReport("/tmp/repo", true)
	b, err := json.Marshal(r)
	if err != nil {
		t.Fatalf("marshal failed: %v", err)
	}
	var roundtrip map[string]interface{}
	if err := json.Unmarshal(b, &roundtrip); err != nil {
		t.Fatalf("roundtrip failed: %v", err)
	}
	required := []string{
		"event", "platform", "repo",
		"rlimitCpu", "rlimitMem", "rlimitFds",
		"wallClockKill", "noNetwork", "envScrub", "pathValidation",
	}
	for _, key := range required {
		if _, ok := roundtrip[key]; !ok {
			t.Errorf("missing JSON key %q in %s", key, b)
		}
	}
}
