package main

import (
	"testing"
)

func TestValidateArgPath_AllowsRepoRelative(t *testing.T) {
	if err := validateArgPath("/home/user/repo", nil, "src/foo.go"); err != nil {
		t.Fatalf("expected relative path to pass, got %v", err)
	}
}

func TestValidateArgPath_AllowsInsideRepo(t *testing.T) {
	if err := validateArgPath("/home/user/repo", nil, "/home/user/repo/src/foo.go"); err != nil {
		t.Fatalf("expected in-repo absolute path to pass, got %v", err)
	}
}

func TestValidateArgPath_RejectsOutsideRepo(t *testing.T) {
	if err := validateArgPath("/home/user/repo", nil, "/etc/passwd"); err == nil {
		t.Fatal("expected /etc/passwd to be rejected")
	}
}

func TestValidateArgPath_AllowsExplicitAllow(t *testing.T) {
	if err := validateArgPath("/home/user/repo", pathList{"/tmp"}, "/tmp/scratch.log"); err != nil {
		t.Fatalf("expected --allow-path /tmp to permit /tmp/scratch.log, got %v", err)
	}
}

func TestValidateArgPath_StripsFlagEquals(t *testing.T) {
	// git --git-dir=/etc/foo should be rejected on the /etc/foo portion.
	if err := validateArgPath("/home/user/repo", nil, "--git-dir=/etc/shadow"); err == nil {
		t.Fatal("expected --git-dir=/etc/shadow to be rejected")
	}
}

func TestValidateArgPath_IgnoresNonPaths(t *testing.T) {
	for _, a := range []string{"status", "-v", "HEAD~1", "origin"} {
		if err := validateArgPath("/home/user/repo", nil, a); err != nil {
			t.Fatalf("expected %q to pass, got %v", a, err)
		}
	}
}

func TestInside(t *testing.T) {
	cases := []struct {
		child, parent string
		want          bool
	}{
		{"/a/b/c", "/a/b", true},
		{"/a/b", "/a/b", true},
		{"/a/bc", "/a/b", false},
		{"/a", "/a/b", false},
	}
	for _, c := range cases {
		if got := inside(c.child, c.parent); got != c.want {
			t.Errorf("inside(%q,%q)=%v want %v", c.child, c.parent, got, c.want)
		}
	}
}
