# Homebrew formula for claudestruct (W7.7).
#
# This file lives in the source tree as a template; publishing happens
# via the dedicated tap repo `tonyandclaw/homebrew-tap`. The release
# workflow (W4.3, pending) replaces the version + sha256 fields and
# pushes a fresh copy to the tap on every tagged release.
#
# Install (after the tap is set up):
#
#   brew tap tonyandclaw/tap
#   brew install claudestruct
#
# claw-sandbox (Go binary) and claw-squad (Node) are not packaged here
# yet -- the formula installs the Python CLI only. A "claudestruct-full"
# bottle that bundles all three lands once W4.3 release automation
# provides reproducible artifacts for the Go + Node halves.

class Claudestruct < Formula
  include Language::Python::Virtualenv

  desc "Token-efficient Claude Code companion for dev / review / planning / debug"
  homepage "https://github.com/tonyandclaw/claudeStruct"
  # url, sha256, and version are filled in by the release workflow.
  url "https://files.pythonhosted.org/packages/source/c/claudestruct/claudestruct-VERSION.tar.gz"
  sha256 "SHA256_PLACEHOLDER"
  license "MIT"

  depends_on "[email protected]"

  # Generated via `brew update-python-resources` against the published
  # wheel; this template lists the direct deps. Transitive resources
  # are added by the release workflow before the bottle is built.
  resource "anthropic" do
    url "https://files.pythonhosted.org/packages/source/a/anthropic/anthropic-LATEST.tar.gz"
  end

  resource "click" do
    url "https://files.pythonhosted.org/packages/source/c/click/click-LATEST.tar.gz"
  end

  resource "rich" do
    url "https://files.pythonhosted.org/packages/source/r/rich/rich-LATEST.tar.gz"
  end

  resource "pathspec" do
    url "https://files.pythonhosted.org/packages/source/p/pathspec/pathspec-LATEST.tar.gz"
  end

  def install
    virtualenv_install_with_resources
  end

  test do
    # Smoke: the CLI renders --help without an API key.
    assert_match "Token-efficient Claude Code companion", shell_output("#{bin}/cs --help")
  end
end
