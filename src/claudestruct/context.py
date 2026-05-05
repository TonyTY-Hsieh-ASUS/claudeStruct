"""Smart context gathering for Claude tasks.

Goal: send the minimum relevant context to Claude for each task type. Uses git
to identify recently-changed files, respects .gitignore, and applies per-task
heuristics to pick what matters.

The file list returned by each gatherer is sorted deterministically so that
prompt caching works across repeated runs on the same working state.
"""
from __future__ import annotations

import subprocess
from dataclasses import dataclass, field
from pathlib import Path

import pathspec

DEFAULT_MAX_FILE_BYTES = 80_000
# Default total context size per task. The numbers reflect the shape of
# what each task type actually needs:
#   - review: works off the staged/unstaged diff — bigger budget is
#     wasted because Reviewer rarely benefits from extra siblings.
#   - dev:    needs the focused files + maybe a couple of callers.
#   - plan:   architecture work; reading further afield earns its keep.
#   - debug:  the failing path is usually narrower than dev's — too
#     much surrounding code makes hypothesis-ranking noisier.
# Override per-call via the CLI's `--max-bytes` flag.
BUDGETS_PER_TASK: dict[str, int] = {
    "review": 200_000,
    "dev": 600_000,
    "plan": 800_000,
    "debug": 400_000,
}
DEFAULT_MAX_TOTAL_BYTES = BUDGETS_PER_TASK["dev"]


def task_budget(task: str) -> int:
    """Look up the per-task default. Falls back to DEFAULT_MAX_TOTAL_BYTES
    so an unknown task name (e.g. a future addition) still gets a sane
    cap instead of a KeyError."""
    return BUDGETS_PER_TASK.get(task, DEFAULT_MAX_TOTAL_BYTES)

BINARY_EXTENSIONS = {
    ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".bmp",
    ".pdf", ".zip", ".tar", ".gz", ".bz2", ".xz", ".7z",
    ".mp3", ".mp4", ".mov", ".avi", ".webm",
    ".pyc", ".pyo", ".so", ".dylib", ".dll", ".exe",
    ".ttf", ".woff", ".woff2", ".eot",
}

SOURCE_EXTENSIONS = {
    ".py", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
    ".go", ".rs", ".java", ".kt", ".scala",
    ".rb", ".php", ".cs", ".swift", ".m", ".mm",
    ".c", ".cc", ".cpp", ".h", ".hpp",
    ".sh", ".bash", ".zsh", ".fish",
    ".sql", ".graphql", ".proto",
    ".html", ".css", ".scss", ".sass", ".less", ".vue", ".svelte",
    ".json", ".yaml", ".yml", ".toml", ".ini", ".env.example",
    ".md", ".rst", ".txt",
}


@dataclass
class FileEntry:
    path: Path
    content: str
    bytes: int

    @property
    def rel(self) -> str:
        return str(self.path)


@dataclass
class Context:
    root: Path
    files: list[FileEntry] = field(default_factory=list)
    git_info: dict[str, str] = field(default_factory=dict)
    skipped: list[tuple[str, str]] = field(default_factory=list)
    total_bytes: int = 0

    def render(self) -> str:
        """Render the context as a single string for inclusion in a prompt."""
        parts: list[str] = []
        if self.git_info:
            parts.append("## Git state")
            for key, value in self.git_info.items():
                parts.append(f"- {key}: {value}")
            parts.append("")
        if self.files:
            parts.append("## Files")
            for f in self.files:
                parts.append(f"### `{f.rel}`")
                parts.append("```")
                parts.append(f.content)
                parts.append("```")
                parts.append("")
        return "\n".join(parts)


def _run_git(root: Path, *args: str) -> str | None:
    try:
        result = subprocess.run(
            ["git", *args],
            cwd=root,
            capture_output=True,
            text=True,
            check=False,
            timeout=5,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return None
    if result.returncode != 0:
        return None
    return result.stdout.strip()


def _load_gitignore(root: Path) -> pathspec.PathSpec:
    patterns: list[str] = [
        ".git/",
        "node_modules/",
        "__pycache__/",
        ".venv/",
        "venv/",
        "dist/",
        "build/",
        ".next/",
        ".nuxt/",
        "target/",
        ".idea/",
        ".vscode/",
    ]
    gitignore = root / ".gitignore"
    if gitignore.exists():
        patterns.extend(gitignore.read_text(encoding="utf-8", errors="replace").splitlines())
    return pathspec.GitIgnoreSpec.from_lines(patterns)


def _is_text_file(path: Path) -> bool:
    if path.suffix.lower() in BINARY_EXTENSIONS:
        return False
    try:
        with path.open("rb") as fh:
            chunk = fh.read(2048)
    except OSError:
        return False
    if b"\0" in chunk:
        return False
    return True


def _collect_file(
    ctx: Context,
    path: Path,
    max_file_bytes: int,
) -> None:
    rel = path.relative_to(ctx.root)
    try:
        size = path.stat().st_size
    except OSError as exc:
        ctx.skipped.append((str(rel), f"stat failed: {exc}"))
        return
    if size > max_file_bytes:
        ctx.skipped.append((str(rel), f"too large ({size} bytes)"))
        return
    if not _is_text_file(path):
        ctx.skipped.append((str(rel), "binary"))
        return
    try:
        content = path.read_text(encoding="utf-8", errors="replace")
    except OSError as exc:
        ctx.skipped.append((str(rel), f"read failed: {exc}"))
        return
    ctx.files.append(FileEntry(path=rel, content=content, bytes=size))
    ctx.total_bytes += size


def _git_info(root: Path) -> dict[str, str]:
    info: dict[str, str] = {}
    branch = _run_git(root, "rev-parse", "--abbrev-ref", "HEAD")
    if branch:
        info["branch"] = branch
    head = _run_git(root, "rev-parse", "--short", "HEAD")
    if head:
        info["head"] = head
    status = _run_git(root, "status", "--porcelain=v1")
    if status is not None:
        lines = [line for line in status.splitlines() if line.strip()]
        info["dirty files"] = str(len(lines))
    return info


def _changed_files(root: Path) -> list[Path]:
    """Return the union of staged, unstaged, and untracked files (deduped, sorted)."""
    seen: set[str] = set()
    out: list[Path] = []
    for args in (
        ["diff", "--name-only", "HEAD"],
        ["diff", "--name-only", "--cached"],
        ["ls-files", "--others", "--exclude-standard"],
    ):
        result = _run_git(root, *args)
        if not result:
            continue
        for line in result.splitlines():
            line = line.strip()
            if not line or line in seen:
                continue
            seen.add(line)
            candidate = root / line
            if candidate.is_file():
                out.append(candidate)
    out.sort(key=lambda p: str(p.relative_to(root)))
    return out


def _walk_source_files(root: Path, spec: pathspec.PathSpec) -> list[Path]:
    out: list[Path] = []
    for path in root.rglob("*"):
        if not path.is_file():
            continue
        rel = str(path.relative_to(root))
        if spec.match_file(rel):
            continue
        if path.suffix.lower() not in SOURCE_EXTENSIONS:
            continue
        out.append(path)
    out.sort(key=lambda p: str(p.relative_to(root)))
    return out


def gather_dev_context(
    root: Path,
    explicit_paths: list[Path] | None = None,
    max_file_bytes: int = DEFAULT_MAX_FILE_BYTES,
    max_total_bytes: int = BUDGETS_PER_TASK["dev"],
) -> Context:
    """Context for a dev task: explicit files + recently changed files."""
    ctx = Context(root=root, git_info=_git_info(root))
    spec = _load_gitignore(root)

    candidates: list[Path] = []
    if explicit_paths:
        for p in explicit_paths:
            abs_p = p if p.is_absolute() else (root / p)
            if abs_p.is_file():
                candidates.append(abs_p)
    else:
        candidates = _changed_files(root)

    seen: set[Path] = set()
    for path in candidates:
        if path in seen:
            continue
        seen.add(path)
        rel = str(path.relative_to(root))
        if spec.match_file(rel):
            continue
        if ctx.total_bytes >= max_total_bytes:
            ctx.skipped.append((rel, "total budget exceeded"))
            continue
        _collect_file(ctx, path, max_file_bytes)
    return ctx


def gather_review_context(
    root: Path,
    explicit_paths: list[Path] | None = None,
    max_file_bytes: int = DEFAULT_MAX_FILE_BYTES,
    max_total_bytes: int = BUDGETS_PER_TASK["review"],
) -> Context:
    """Context for code review: explicit files, or the diff against main/master."""
    ctx = Context(root=root, git_info=_git_info(root))
    spec = _load_gitignore(root)

    if explicit_paths:
        candidates = [
            (p if p.is_absolute() else (root / p))
            for p in explicit_paths
            if (p if p.is_absolute() else (root / p)).is_file()
        ]
    else:
        base = None
        for candidate in ("origin/main", "origin/master", "main", "master"):
            if _run_git(root, "rev-parse", "--verify", candidate) is not None:
                base = candidate
                break
        if base:
            diff = _run_git(root, "diff", "--name-only", f"{base}...HEAD")
            if diff:
                candidates = [root / line for line in diff.splitlines() if line.strip()]
                ctx.git_info["base"] = base
            else:
                candidates = _changed_files(root)
        else:
            candidates = _changed_files(root)

    for path in candidates:
        if not path.is_file():
            continue
        rel = str(path.relative_to(root))
        if spec.match_file(rel):
            continue
        if ctx.total_bytes >= max_total_bytes:
            ctx.skipped.append((rel, "total budget exceeded"))
            continue
        _collect_file(ctx, path, max_file_bytes)
    return ctx


def gather_plan_context(
    root: Path,
    explicit_paths: list[Path] | None = None,
    max_file_bytes: int = DEFAULT_MAX_FILE_BYTES,
    max_total_bytes: int = BUDGETS_PER_TASK["plan"],
) -> Context:
    """Context for planning: architecture signals — top-level files, README, configs."""
    ctx = Context(root=root, git_info=_git_info(root))
    spec = _load_gitignore(root)

    priority = [
        "README.md", "README.rst", "README.txt", "README",
        "CLAUDE.md", "AGENTS.md", "ARCHITECTURE.md", "DESIGN.md",
        "pyproject.toml", "setup.py", "setup.cfg",
        "package.json", "tsconfig.json",
        "Cargo.toml", "go.mod", "pom.xml", "build.gradle", "build.gradle.kts",
        "Gemfile", "composer.json",
    ]
    candidates: list[Path] = []
    if explicit_paths:
        for p in explicit_paths:
            abs_p = p if p.is_absolute() else (root / p)
            if abs_p.is_file():
                candidates.append(abs_p)
    else:
        for name in priority:
            candidate = root / name
            if candidate.is_file():
                candidates.append(candidate)
        for subdir in ("src", "lib", "app"):
            sub = root / subdir
            if sub.is_dir():
                for path in sub.rglob("*"):
                    if not path.is_file():
                        continue
                    if path.suffix.lower() in SOURCE_EXTENSIONS:
                        candidates.append(path)
                        if len(candidates) > 40:
                            break

    for path in candidates:
        rel = str(path.relative_to(root))
        if spec.match_file(rel):
            continue
        if ctx.total_bytes >= max_total_bytes:
            ctx.skipped.append((rel, "total budget exceeded"))
            continue
        _collect_file(ctx, path, max_file_bytes)
    return ctx


def gather_debug_context(
    root: Path,
    explicit_paths: list[Path] | None = None,
    max_file_bytes: int = DEFAULT_MAX_FILE_BYTES,
    max_total_bytes: int = BUDGETS_PER_TASK["debug"],
) -> Context:
    """Context for debugging: dirty files first, then recently-modified files."""
    ctx = Context(root=root, git_info=_git_info(root))
    spec = _load_gitignore(root)

    if explicit_paths:
        candidates = [
            (p if p.is_absolute() else (root / p))
            for p in explicit_paths
            if (p if p.is_absolute() else (root / p)).is_file()
        ]
    else:
        candidates = _changed_files(root)
        if not candidates:
            # Fallback: walk for source files and sort by mtime
            all_src = _walk_source_files(root, spec)
            all_src.sort(key=lambda p: p.stat().st_mtime, reverse=True)
            candidates = all_src[:15]

    for path in candidates:
        rel = str(path.relative_to(root))
        if spec.match_file(rel):
            continue
        if ctx.total_bytes >= max_total_bytes:
            ctx.skipped.append((rel, "total budget exceeded"))
            continue
        _collect_file(ctx, path, max_file_bytes)
    return ctx
