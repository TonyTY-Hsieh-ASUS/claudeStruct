package dev.claudestruct.jetbrains.actions

import dev.claudestruct.jetbrains.CsRunner

/**
 * `cs review` — no description prompt; the CLI handles the
 * "review the current branch diff" default. Right-clicking a file
 * (or set of files) narrows the review to those paths.
 */
class ReviewAction : CsActionBase(CsRunner.CsTask.REVIEW, needsDescription = false)
