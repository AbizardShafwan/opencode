export * as ReviewAuthority from "./review-authority.js"

import type { Permission } from "../permission.js"

/**
 * Policy-guided read-only capabilities for one-shot reviews. The leading deny-all
 * is the hard ceiling for an independent authority ruleset; each allowed capability
 * is explicit because an unmatched rule contributes `ask`. Shell commands are
 * constrained by the assigned prompt, not by an OS sandbox.
 */
export const rules: Permission.Ruleset = [
  { action: "*", resource: "*", effect: "deny" },
  { action: "shell", resource: "*", effect: "allow" },
  { action: "grep", resource: "*", effect: "allow" },
  { action: "glob", resource: "*", effect: "allow" },
  { action: "read", resource: "*", effect: "allow" },
  { action: "read", resource: "*.env", effect: "ask" },
  { action: "read", resource: "*.env.*", effect: "ask" },
  { action: "read", resource: "*.env.example", effect: "allow" },
  { action: "external_directory", resource: "*", effect: "allow" },
  // Exact read-only T3 Code host actions; never a wildcard over the reserved `t3-code_` namespace.
  ...[
    "t3-code_pull_request_read",
    "t3-code_pull_request_list",
    "t3-code_ci_logs",
    "t3-code_read_pull_request_guide",
    "t3-code_list_issues",
    "t3-code_read_issue",
    "t3-code_list_thread_pull_requests",
    "t3-code_list_thread_issues",
    "t3-code_html_preview",
    "t3-code_html_render",
  ].map((action) => ({ action, resource: "*", effect: "allow" as const })),
]
