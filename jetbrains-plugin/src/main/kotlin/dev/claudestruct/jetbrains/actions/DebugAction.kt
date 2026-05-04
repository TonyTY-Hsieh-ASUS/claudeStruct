package dev.claudestruct.jetbrains.actions

import dev.claudestruct.jetbrains.CsRunner

class DebugAction : CsActionBase(CsRunner.CsTask.DEBUG, needsDescription = true)
