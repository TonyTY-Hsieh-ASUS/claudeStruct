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
//   - Network egress (W10.9): real CLONE_NEWNET cut-off when running as
//     root or inside an unprivileged user namespace. The flag defaults
//     to ON whenever the kernel will let us deliver it; the structured
//     isolation report's `noNetwork` field declares the actual outcome
//     so callers never confuse "asked for" with "got". On macOS and
//     non-root init-namespace Linux, an honest no-op.
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
//   --no-network         advise kernel to drop network (best-effort, needs root)
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
	repoDir    string
	cpuSec     int
	wallSec    int
	memMB      int
	noNetwork  bool
	verbose    bool
	allowPaths pathList
)

func main() {
	flag.StringVar(&repoDir, "repo", "", "repository root (required)")
	flag.IntVar(&cpuSec, "cpu", 60, "CPU time limit (seconds)")
	flag.IntVar(&wallSec, "wall", 300, "wall clock limit (seconds)")
	flag.IntVar(&memMB, "mem-mb", 1024, "virtual memory limit (MB)")
	// W10.9: --no-network is now genuinely enforceable on Linux when
	// the daemon runs as root or inside an unprivileged user
	// namespace. We default it to ON when the platform supports it,
	// OFF otherwise — the structured isolation report makes the
	// actual outcome visible either way. Users who explicitly
	// re-enable network can pass --network or set the flag false.
	flag.BoolVar(&noNetwork, "no-network", isolationCapabilities().network != statusUnsupported,
		"request network isolation. On Linux+root (or unprivileged userns) the kernel CLONE_NEWNET cuts off the child; otherwise honest no-op.")
	flag.BoolVar(&noNetwork, "network", noNetwork, "DEPRECATED: pass --no-network=false to opt out of network isolation when the platform supports it")
	flag.BoolVar(&verbose, "verbose", false, "log enforced limits")
	flag.Var(&allowPaths, "allow-path", "additional allowed path (repeatable)")
	flag.Parse()

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
