"""Tests for the per-task prompt version stamping."""
from __future__ import annotations

import hashlib

from claudestruct.prompts import (
    TASK_PROMPTS,
    TASK_PROMPT_VERSIONS,
    prompt_version,
)


def test_every_task_has_a_version():
    assert set(TASK_PROMPT_VERSIONS) == set(TASK_PROMPTS)


def test_version_is_8_char_hex():
    for task, v in TASK_PROMPT_VERSIONS.items():
        assert len(v) == 8, f"{task}: {v}"
        assert all(c in "0123456789abcdef" for c in v), f"{task}: {v}"


def test_version_matches_sha256_prefix():
    for task, prompt in TASK_PROMPTS.items():
        expected = hashlib.sha256(prompt.encode("utf-8")).hexdigest()[:8]
        assert prompt_version(task) == expected


def test_versions_differ_between_tasks():
    """The four task prompts are different texts, so their hashes
    should also differ. This guards against an accidental copy-paste
    that leaves two tasks pointing at the same prompt."""
    seen = set()
    for v in TASK_PROMPT_VERSIONS.values():
        assert v not in seen, f"duplicate version {v}"
        seen.add(v)
