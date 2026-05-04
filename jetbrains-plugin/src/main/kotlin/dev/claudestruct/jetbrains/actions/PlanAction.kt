package dev.claudestruct.jetbrains.actions

import dev.claudestruct.jetbrains.CsRunner

class PlanAction : CsActionBase(CsRunner.CsTask.PLAN, needsDescription = true)
