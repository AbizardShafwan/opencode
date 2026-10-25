/** Display aliases preserve the recorded tool name while sharing the appropriate renderer. */
export function canonicalToolName(name: string) {
  if (name === "bash") return "shell"
  if (name === "task" || name === "spawn_agent" || name === "followup_task") return "subagent"
  if (name === "apply_patch") return "patch"
  return name
}

export function isSubagent(name: string) {
  return canonicalToolName(name) === "subagent"
}
