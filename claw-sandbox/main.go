// claw-sandbox wraps a subprocess with conservative security defaults.
//
// Intended use: claw-squad invokes `git`, shell commands, and test runners
// through this binary when the user passes --sandbox. OFF by default per the
// user's spec.
//
// Enforcement (Linux):
//   - rlimits: CPU time, wall clock, virtual memory, open files.
//   - Working directory confined to --repo (argv paths validated).
//   - Environment stripped to a safe allowlist (PATH, HOME, LANG, USER, TERM).
//   - Network egress: real CLONE_NEWNET isolation when the kernel + caps
//     allow it (Linux + root, or already inside an unprivileged userns).
//     On those hosts --no-network defaults to ON; --allow-network opts
//     out for `npm install` / `pip install` workflows. On hosts that
//     can't enforce, the flag remains opt-in and is honest about the
//     resulting status via the structured isolation report.
//
// Non-goals: this is a *defense-in-depth* helper, not a replacement for a
// VM or container sandbox. Against a motivated adversary with code execution,
// rlimits + env scrubbing are a speed bump, not a wall.
//
// Usage:
//   claw-sandbox [flags] --repo <dir> -- <cmd> [args...]
//
// Flags:
//   --repo <dir>         required; cwd for child and anchor for path checks
//   --cpu <seconds>      CPU time limit   (default 60)
//   --wall <seconds>     wall clock limit (default 300)
//   --mem-mb <int>       virtual memory   (default 1024)
//   --no-network         force network isolation on (Linux: real netns;
//                        elsewhere: emits unsupported in the report)
//   --allow-network      force network isolation off (cancels the auto-on
//                        default that fires on Linux + root)
//   --allow-path <path>  extra allowed read/write path (repeatable)
//   --verbose            print enforced limits before exec
package main

import (
	"flag"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

type pathList []string

func (p *pathList) String() string { return strings.Join(*p, ",") }
func (p *pathList) Set(v string) error {
	*p = append(*p, v)
	return nil
}

var (
	repoDir      string
	cpuSec       int
	wallSec      int
	memMB        int
	noNetwork    bool
	allowNetwork bool
	verbose      bool
	allowPaths   pathList
)

func main() {
	flag.StringVar(&repoDir, "repo", "", "repository root (required)")
	flag.IntVar(&cpuSec, "cpu", 60, "CPU time limit (seconds)")
	flag.IntVar(&wallSec, "wall", 300, "wall clock limit (seconds)")
	flag.IntVar(&memMB, "mem-mb", 1024, "virtual memory limit (MB)")
	flag.BoolVar(&noNetwork, "no-network", false,
		"request network isolation (auto-on as root on Linux; opt out via --allow-network)")
	flag.BoolVar(&allowNetwork, "allow-network", false,
		"opt out of the auto-on --no-network default (Linux + root only)")
	flag.BoolVar(&verbose, "verbose", false, "log enforced limits")
	flag.Var(&allowPaths, "allow-path", "additional allowed path (repeatable)")
	flag.Parse()

	// Resolve --no-network with the auto-on policy. Treat the two flags
	// as opposing intents so the operator can express "force on", "force
	// off", or "let the host decide". Default before W10.9 was OFF —
	// the new default ON only kicks in when we can deliver real isolation
	// (CAP_SYS_ADMIN or unprivileged userns with caps), so existing
	// non-root callers see no behaviour change.
	noNetwork = resolveNoNetwork(noNetwork, allowNetwork)

	if repoDir == "" {
		die("--repo is required")
	}
	absRepo, err := filepath.Abs(repoDir)
	if err != nil {
		die("failed to resolve --repo: %v", err)
	}
	if st, err := os.Stat(absRepo); err != nil || !st.IsDir() {
		die("--repo %q is not a directory", absRepo)
	}

	args := flag.Args()
	if len(args) == 0 {
		die("no command given (put command after `--`)")
	}

	// Scrub env to a minimal allowlist. This kills surprises from ambient
	// variables (SSH_AUTH_SOCK, GITHUB_TOKEN, AWS_*, etc.) reaching child.
	cleanEnv := buildEnv()

	// Validate that any path-like argv tokens that resolve to absolute paths
	// either live inside --repo or match --allow-path. This is coarse but
	// catches the common footgun of "git --git-dir=/etc/passwd".
	for _, a := range args {
		if err := validateArgPath(absRepo, allowPaths, a); err != nil {
			die("rejected argument %q: %v", a, err)
		}
	}

	cmd := exec.Command(args[0], args[1:]...)
	cmd.Dir = absRepo
	cmd.Env = cleanEnv
	cmd.Stdin = os.Stdin
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr

	applyRLimits(cmd)
	if noNetwork {
		tryDisableNetwork(cmd)
	}

	// Always emit the structured isolation report, regardless of
	// --verbose. The whole point is that callers (humans and
	// claw-squad) shouldn't have to opt in to learning whether the
	// controls they asked for are actually enforced.
	emitIsolationReport(buildIsolationReport(absRepo, noNetwork))

	if verbose {
		fmt.Fprintf(os.Stderr, "[sandbox] repo=%s cpu=%ds wall=%ds mem=%dMB no-network=%v\n",
			absRepo, cpuSec, wallSec, memMB, noNetwork)
	}

	if err := cmd.Start(); err != nil {
		die("failed to start child: %v", err)
	}

	// Wall-clock watchdog.
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()

	select {
	case err := <-done:
		if err != nil {
			if exitErr, ok := err.(*exec.ExitError); ok {
				os.Exit(exitErr.ExitCode())
			}
			die("child failed: %v", err)
		}
	case <-time.After(time.Duration(wallSec) * time.Second):
		_ = cmd.Process.Kill()
		die("wall clock limit exceeded (%ds)", wallSec)
	}
}

// resolveNoNetwork decides whether to actually try CLONE_NEWNET. Three
// inputs feed the choice:
//
//   - noNetworkRequested: --no-network was passed on the CLI.
//   - allowNetworkRequested: --allow-network was passed on the CLI.
//   - shouldDefaultNoNetwork(): the host CAN enforce isolation today.
//
// The policy:
//
//   - Explicit --no-network wins. We try, even if caps say we can't —
//     the kernel will tell us, and the isolation report records the
//     resulting status.
//   - Explicit --allow-network forces OFF. Useful for `npm install`
//     workflows that need the registry.
//   - Both flags set: explicit conflict, treat as OFF and warn (caller
//     should fix their invocation; we don't crash).
//   - Neither set: ON iff the host reports "enforced" caps. The
//     "best-effort" tier (already inside a userns) is left OFF by
//     default — that environment usually has its own outer isolation
//     and surprising the operator with a nested netns rarely helps.
func resolveNoNetwork(noNetworkRequested, allowNetworkRequested bool) bool {
	if noNetworkRequested && allowNetworkRequested {
		fmt.Fprintln(os.Stderr,
			"claw-sandbox: --no-network and --allow-network both passed; treating as --allow-network")
		return false
	}
	if allowNetworkRequested {
		return false
	}
	if noNetworkRequested {
		return true
	}
	return shouldDefaultNoNetwork()
}

func die(format string, a ...any) {
	fmt.Fprintln(os.Stderr, "claw-sandbox: "+fmt.Sprintf(format, a...))
	os.Exit(2)
}

func buildEnv() []string {
	allow := []string{"PATH", "HOME", "LANG", "LC_ALL", "USER", "TERM", "SHELL"}
	out := make([]string, 0, len(allow))
	for _, k := range allow {
		if v := os.Getenv(k); v != "" {
			out = append(out, k+"="+v)
		}
	}
	// Explicit minimum PATH in case the caller stripped it.
	if os.Getenv("PATH") == "" {
		out = append(out, "PATH=/usr/local/bin:/usr/bin:/bin")
	}
	return out
}

func validateArgPath(repo string, allowed pathList, arg string) error {
	// Only validate tokens that LOOK like paths (contain / or start with ./ .. /).
	if !strings.ContainsAny(arg, "/") {
		return nil
	}
	// Strip leading --flag= if any.
	if eq := strings.Index(arg, "="); eq >= 0 && strings.HasPrefix(arg, "--") {
		arg = arg[eq+1:]
	}
	if !filepath.IsAbs(arg) {
		return nil
	}
	abs := filepath.Clean(arg)
	if inside(abs, repo) {
		return nil
	}
	for _, p := range allowed {
		pAbs, err := filepath.Abs(p)
		if err != nil {
			continue
		}
		if inside(abs, pAbs) {
			return nil
		}
	}
	return fmt.Errorf("path %q is outside --repo and --allow-path list", abs)
}

func inside(child, parent string) bool {
	rel, err := filepath.Rel(parent, child)
	if err != nil {
		return false
	}
	return !strings.HasPrefix(rel, "..") && !filepath.IsAbs(rel)
}

// applyRLimits is implemented in OS-specific files (rlimit_linux.go,
// rlimit_other.go). On non-Linux hosts the limits are best-effort.
