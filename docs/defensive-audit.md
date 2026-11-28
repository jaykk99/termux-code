# Local defensive audit and execution diagnostics

From the installed CLI, change into a repository you own and run `termux-code-audit`. From the repository checkout, run `npm run security:audit`.

The audit works offline, without model credentials, and reports file permission metadata, symbolic links and missing JavaScript lockfiles. It does not read secrets, execute shell commands, contact remote hosts, or verify dependency vulnerabilities. Review its findings locally; it is not a comprehensive security assessment or an isolation boundary against concurrent filesystem changes.

Exit codes: 0 = complete with no high-severity findings; 1 = high-severity findings; 2 = incomplete, unreadable, or invalid invocation. A clean result does not establish that a workspace is secure.

CLI JSON execution diagnostics distinguish actual completion calls and tool results from the configured step budget, and report verification and stop reasons. These fields are observations, not a guarantee that a model finished all requested work.

The detail list is capped at 50 entries; severity counts include all observed findings. Higher-severity findings take precedence in the displayed details. Newly minted signed gateway tokens default to 30 days (1–90 via `GATEWAY_TOKEN_TTL_DAYS`). Previously issued signed tokens retain their embedded expiry. Rotate the signing secret to invalidate them; deleting legacy tokens does not revoke signed tokens. Token API responses are marked no-store.

The offline metadata audit automatically traverses the eligible local workspace until the queue is exhausted. It no longer stops at 1,500 entries by default. Resource safeguards are 50,000 entries and approximately 60 seconds (filesystem calls themselves may take longer). Reports include observed coverage, elapsed time, completion status and a specific stop reason. Exhausting a safeguard is incomplete, never a clean audit. This does not change the model-driven agent loop, network permissions, or tool execution limits.

## Local verification

Run `npm run verify:local` in this checkout, or `node /path/to/termux-code/bin/local-verify.mjs` in another local project. It runs the offline metadata audit and discovers package manifests and explicit Node module files (`.mjs`, `.cjs`), parsing them without executing project code. It checks ordinary `.js` syntax when the nearest package manifest explicitly declares `module` or `commonjs`. Ambiguous `.js` files are reported as incomplete rather than silently skipped. It skips hidden paths, generated directories, symlinks, JSX and TypeScript. It reports every attempted supported file, syntax failures and incomplete coverage, subject to bounded time, file size, file count and traversal limits. No model or remote service is involved. This is not a replacement for application tests or an adaptive model execution engine. Exit codes: 0 = supported checks passed, 1 = complete with failures/high findings, 2 = incomplete/no supported files.
