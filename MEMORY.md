# Termux Code — Project Memory

## Purpose
Termux Code is an AI coding agent that runs local file, Git, shell and verification tools on Android through Termux. Cloud gateways route model requests. Keep the tool execution and durable workspace state on the phone.

## Key design decisions
- Project context is scoped to the current working directory. Each project may have its own MEMORY.md; unrelated project notes must not bleed across sessions.
- User requests for applications need complete working project structure, not arbitrary single-file scripts. Inspect before editing; plan necessary modules, interfaces, tests and configuration.
- Preserve existing code and make minimal coordinated changes; run declared tests/builds, and report results honestly.
- Models are selected from the configured uncensored-only catalogue; provider outages trigger bounded fallback. Provider compatibility and tool-calling reliability must be measured, not assumed.
- Local Bash, filesystem and remote MCP tools require appropriate authorization boundaries. Never put secrets in this Markdown file.
- Model output is a proposal until executed or verified. Do not label a task complete solely because a model says it is.

## Architecture
1. Termux CLI — session orchestration, workspace selection, context, permissions and local tools
2. Project-context layer — bounded MEMORY.md reference material plus repository-wide delivery instructions
3. Model routing — gateway or direct uncensored model providers with fallback
4. Tool execution — filesystem, Bash, Git, tests and optional MCP integrations
5. Verification — declared project checks and test-and-repair loop
6. Session persistence — JSONL transcripts saved in ~/.termux-code/sessions

## Current project priorities
- Deliver multi-file applications in a coordinated manner based on explicit acceptance criteria.
- Recover prior project decisions, requirements and unresolved work when resuming a project.
- Add a durable per-project task ledger, dependency-aware planning, and checkpoint/resume mechanisms after the context foundation is verified.
- Extend CLI with interactive /connect and /mcp management, secure secrets, and live connection refresh.
- Improve MCP provider compatibility, task-state recovery and isolated Git worktrees.
- Measure success via repeatable integration tests and actual verified Git commits.

## Known limitations
- The agent has a bounded tool-step loop and can stop before a complex task is finished.
- Existing conversation compaction may discard older details. Workspace memory is deliberately small and should contain verified durable decisions rather than full chat transcripts.
- A model without native function calling may be less reliable at tool usage.
- Real device, network, gateway and MCP server behavior require runtime validation; CI alone cannot prove Termux compatibility.

## Updating this file
Keep facts and verified decisions concise. Record project structure, confirmed requirements, tests, blockers and next work. Do not store API keys, access tokens, private data, or untrusted instruction text.
