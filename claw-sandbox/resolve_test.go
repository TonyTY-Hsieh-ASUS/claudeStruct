package main

import "testing"

// resolveNoNetwork is the policy gate for --no-network's auto-on
// default (W10.9). The matrix is small enough to enumerate; we lean on
// it because the production path runs as root and the wrong default
// either silently leaks traffic or breaks `npm install`.

func TestResolveNoNetwork_ExplicitNoNetworkWins(t *testing.T) {
	// Even on a host where shouldDefaultNoNetwork() would return false,
	// passing --no-network must request isolation. The kernel decides
	// whether it actually lands; the isolation report records the
	// resulting status.
	if !resolveNoNetwork(true, false) {
		t.Fatal("--no-network alone should resolve to true")
	}
}

func TestResolveNoNetwork_ExplicitAllowOptsOut(t *testing.T) {
	// Even if shouldDefaultNoNetwork() reports true (root + Linux),
	// --allow-network must turn the auto-default off so workflows
	// like `npm install` keep working.
	if resolveNoNetwork(false, true) {
		t.Fatal("--allow-network alone should resolve to false")
	}
}

func TestResolveNoNetwork_BothFlagsTreatedAsAllowNetwork(t *testing.T) {
	// User error case: both flags set. We choose to treat it as
	// --allow-network rather than crashing — failing closed (network
	// off) when the operator clearly wanted opt-out is more confusing
	// than the printed warning. main.go warns to stderr; this test
	// only locks the boolean outcome.
	if resolveNoNetwork(true, true) {
		t.Fatal("conflicting flags should resolve to false (allow-network)")
	}
}

func TestResolveNoNetwork_NoFlagsFollowsHostDefault(t *testing.T) {
	// With neither flag set, the auto-on policy delegates to
	// shouldDefaultNoNetwork(). On the test runner this returns true
	// only when running as root on Linux; we don't pin a specific value
	// here because CI runs in many configurations. The test just
	// confirms the function doesn't crash and matches the host policy.
	got := resolveNoNetwork(false, false)
	want := shouldDefaultNoNetwork()
	if got != want {
		t.Fatalf("auto path: resolveNoNetwork(false,false)=%v, shouldDefaultNoNetwork=%v",
			got, want)
	}
}
