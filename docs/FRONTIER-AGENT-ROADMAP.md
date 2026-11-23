# Frontier Agent Architecture Roadmap

This is an engineering plan, **not** a list of completed features. The next milestone is reliable, multi-file delivery with project-scoped context.

## Prioritized capabilities (20)
| # | Capability | Observable acceptance criterion |
|---|---|---|
| 1 | Adaptive reasoning controller | Effort changes based on task complexity and test-risk signals |
| 2 | Specialist agents | Planner, implementer, reviewer and QA each produce independently inspectable artifacts |
| 3 | Persistent project intelligence | Switching repos never mixes workspace memory or incomplete tasks |
| 4 | Browser operator | Open/read/click/type/screenshot tested on real Android Chromium |
| 5 | Visual understanding | A vision-capable provider can inspect screenshots with permission |
| 6 | Full application builder | Complete sample app is generated across multiple files and passes smoke tests |
| 7 | Dependency-aware task graph | Subtasks are ordered, persisted and resumed without duplicating writes |
| 8 | Test-and-repair loop | A failing test triggers bounded retries and honest final status |
| 9 | Independent design critique | Reviewer catches a seeded implementation flaw |
| 10 | Benchmark-driven model router | Routing changes on measured model performance, not name |
| 11 | Repository knowledge graph | Symbol/dependency lookup reaches relevant files consistently |
| 12 | Long-running job checkpoints | Termux process restarts and rehydrates task state |
| 13 | Graphical computer use | UI interactions require supported runtime plus authorization |
| 14 | Reusable skills catalog | A verified workflow can be saved, rerun, and versioned |
| 15 | MCP server manager | Add/test/list/remove remote MCP servers, with auth kept secret |
| 16 | Parallel isolated worktrees | Independent tasks cannot overwrite each other's files |
| 17 | Continuous verification | The CI/test log is attached to exact commit SHA |
| 18 | Strategy optimization | Records validated wins/failures without fabricating learning |
| 19 | Evaluation lab | Reproducible benchmark reports with datasets and scorecards |
| 20 | Unified dashboard | Jobs, status, logs, models and browser sessions are inspectable |

## Added in this branch
- Workspace-specific `MEMORY.md` context, refreshed on new/resumed/cleared CLI sessions.
- Repository-wide delivery instructions to discourage a single-script answer when the task needs a full app.
- `/repo owner/name` and `/repo /local/path`: clone/open repository and switch active workspace.
- `/browser`: diagnostic of available phone browser/gateway capabilities; existing browser tool remains.
- `phone` tool: Termux:API capability check, carrier-reported phone number, SMS command and Android email draft opener.
- Regression tests for the above foundations.

## Work not yet completed
No durable task graph, model debate, deep vision, GUI control outside Chromium, self-training, automatic third-party email-account creation, or cellular phone-number provisioning is claimed in this change.

## Phone setup
Install the **Termux:API Android app** compatible with your Termux installation, then run `pkg install termux-api`. Grant Android permissions required for the specific action. `termux-sms-send` uses an existing active SMS-capable SIM/carrier. `termux-telephony-deviceinfo` may not include a line number. `termux-open-url` opens a mailto draft in a separately configured email application; it does not send or create accounts. The agent's hosted Composio actions remain separate, only available when connected/configured, and may support sending through a connected account.

## Repository usage
Start in the local project with `termux-code -C /path/to/repo`, or while running enter `/repo owner/name` (clone to `~/.termux-code/repos/owner/name` if missing), or `/repo /path/to/checkout`. The CLI starts a fresh workspace-bound agent on switch, reloading models, MCP, project memory and verification. Cloning private repos requires your existing Git authentication; neither a token nor a password is added to the command line.

## Verification
Run `npm test` or targeted `node --test tests/project-context.test.mjs tests/repo-connector.test.mjs tests/phone.test.mjs tests/browser-diagnostic.test.mjs`. GitHub CI and an actual Termux phone still need independent verification.
