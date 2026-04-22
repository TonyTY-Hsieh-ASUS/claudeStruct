"""Smoke tests for context gathering.

These don't hit the Anthropic API — they verify the file-selection and
rendering logic is sane. Run with `pytest` after `pip install -e .`.
"""
from __future__ import annotations

import subprocess
from pathlib import Path

import pytest

from claudestruct.context import (
    gather_debug_context,
    gather_dev_context,
    gather_plan_context,
    gather_review_context,
)


def _init_repo(tmp_path: Path) -> Path:
    subprocess.run(["git", "init", "-q"], cwd=tmp_path, check=True)
    subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=tmp_path, check=True)
    subprocess.run(["git", "config", "user.name", "test"], cwd=tmp_path, check=True)
    subprocess.run(["git", "config", "commit.gpgsign", "false"], cwd=tmp_path, check=True)
    return tmp_path


def test_dev_context_includes_changed_files(tmp_path):
    _init_repo(tmp_path)
    (tmp_path / "base.py").write_text("print('base')\n")
    subprocess.run(["git", "add", "."], cwd=tmp_path, check=True)
    subprocess.run(["git", "commit", "-q", "-m", "init"], cwd=tmp_path, check=True)

    (tmp_path / "new.py").write_text("print('new')\n")
    (tmp_path / "base.py").write_text("print('modified')\n")

    ctx = gather_dev_context(root=tmp_path)
    paths = {f.rel for f in ctx.files}
    assert "new.py" in paths
    assert "base.py" in paths


def test_gitignore_is_respected(tmp_path):
    _init_repo(tmp_path)
    (tmp_path / ".gitignore").write_text("secret.txt\n")
    (tmp_path / "secret.txt").write_text("sensitive\n")
    (tmp_path / "public.py").write_text("ok\n")

    ctx = gather_dev_context(root=tmp_path)
    paths = {f.rel for f in ctx.files}
    assert "public.py" in paths
    assert "secret.txt" not in paths


def test_binary_files_are_skipped(tmp_path):
    _init_repo(tmp_path)
    (tmp_path / "image.png").write_bytes(b"\x89PNG\r\n\x1a\n\x00\x00")
    (tmp_path / "code.py").write_text("x = 1\n")

    ctx = gather_dev_context(root=tmp_path)
    paths = {f.rel for f in ctx.files}
    assert "code.py" in paths
    assert "image.png" not in paths


def test_large_files_are_skipped(tmp_path):
    _init_repo(tmp_path)
    (tmp_path / "huge.py").write_text("x = 1\n" * 10_000)
    (tmp_path / "small.py").write_text("y = 2\n")

    ctx = gather_dev_context(root=tmp_path, max_file_bytes=1024)
    paths = {f.rel for f in ctx.files}
    assert "small.py" in paths
    assert "huge.py" not in paths


def test_plan_context_prioritizes_architecture_files(tmp_path):
    _init_repo(tmp_path)
    (tmp_path / "README.md").write_text("# Project\n")
    (tmp_path / "pyproject.toml").write_text("[project]\nname='x'\n")
    (tmp_path / "random.log").write_text("noise\n")

    ctx = gather_plan_context(root=tmp_path)
    paths = {f.rel for f in ctx.files}
    assert "README.md" in paths
    assert "pyproject.toml" in paths


def test_deterministic_file_order(tmp_path):
    """Prompt caching requires stable ordering."""
    _init_repo(tmp_path)
    for name in ["c.py", "a.py", "b.py"]:
        (tmp_path / name).write_text(f"# {name}\n")

    ctx1 = gather_dev_context(root=tmp_path)
    ctx2 = gather_dev_context(root=tmp_path)
    assert [f.rel for f in ctx1.files] == [f.rel for f in ctx2.files]


def test_explicit_paths_override_git(tmp_path):
    _init_repo(tmp_path)
    (tmp_path / "a.py").write_text("a\n")
    (tmp_path / "b.py").write_text("b\n")
    subprocess.run(["git", "add", "."], cwd=tmp_path, check=True)
    subprocess.run(["git", "commit", "-q", "-m", "init"], cwd=tmp_path, check=True)

    ctx = gather_dev_context(root=tmp_path, explicit_paths=[Path("a.py")])
    paths = {f.rel for f in ctx.files}
    assert paths == {"a.py"}


def test_render_includes_file_content(tmp_path):
    _init_repo(tmp_path)
    (tmp_path / "hello.py").write_text("print('hi')\n")

    ctx = gather_dev_context(root=tmp_path)
    rendered = ctx.render()
    assert "hello.py" in rendered
    assert "print('hi')" in rendered
