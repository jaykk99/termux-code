# Local defensive audit and execution diagnostics

From the installed CLI, change into a repository you own and run `termux-code-audit`. From the repository checkout, run `npm run security:audit`.

The audit works offline, without model credentials, and reports file permission metadata, symbolic links and missing JavaScript lockfiles. It does not read secrets, execute shell commands, contact remote hosts, or verify dependency vulnerabilities. Review its findings locally; it is not a comprehensive security assessment or an isolation boundary against concurrent filesystem changes.

Exit codes: 0 = complete with no high-severity findings; 1 = high-severity findings; 2 = incomplete, unreadable, or invalid invocation. A clean result does not establish that a workspace is secure.

CLI JSON execution diagnostics distinguish actual completion calls and tool results from the configured step budget, and report verification and stop reasons. These fields are observations, not a guarantee that a model finished all requested work.
