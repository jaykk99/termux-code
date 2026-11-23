# Project-Wide Agent Architecture

## Problem
A model frequently responds to a complete-app request by creating only one script.
Older project details disappear from active context after session switches or compaction.

## Proposed execution contract
1. **Discover:** inspect repository paths, read package manifests, relevant docs, tests, and current Git status.
2. **Specify:** translate the request into concrete user-visible acceptance criteria.
3. **Design:** decide which components/files need changes. One-file solutions are valid only when they really satisfy the goal.
4. **Execute:** make incremental coordinated changes while preserving existing working functionality.
5. **Verify:** run appropriate declared tests, builds, and integration checks, and inspect failures.
6. **Resume:** persist incomplete checklist items and blockers for future runs.
7. **Report:** name changed files, actual verification, unresolved issues, and next action.

## Current implementation
- `lib/project-context.mjs` loads a bounded `MEMORY.md` from the active working directory.
- CLI startup and session transitions replace old system context with the active project's instructions.
- The instructions enforce a repository-wide plan and require checking user acceptance criteria.
- This is a prompt/context foundation; it does not yet implement a durable task graph or guarantee end-to-end build completion.

## Planned durable work engine
Use an explicit job store with `task_id`, `workspace`, `objective`, `acceptance_criteria`,
`steps`, `artifacts`, `test_results`, `blocked_reason`, `status`, and `updated_at`.
Write atomically after each tool result. On restart, reconcile current files/Git HEAD with saved state
before retrying a step. Use max-attempt limits and approvals for consequential actions.

## Validation checklist
- Starting from repository A loads only repository A memory.
- Opening repository B never reuses A's memory.
- `/new`, `/clear`, and `/session` restore the active workspace instructions.
- Existing one-shot CLI messages continue to work.
- Project-memory files cannot expose credentials by design; users must keep secrets outside `MEMORY.md`.
- A complete-application test requires multiple interacting files and passes a real integration test.
