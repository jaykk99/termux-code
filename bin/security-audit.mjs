#!/usr/bin/env node
import { auditWorkspace } from '../lib/security-audit.mjs';

// Only audit the user's current local workspace. No model, network or shell.
if (process.argv.length > 2) {
  console.error('Usage: termux-code-audit (run from the workspace to inspect)');
  process.exitCode = 2;
} else {
  try {
    const result = await auditWorkspace(process.cwd());
    console.log(JSON.stringify(result, null, 2));
    if (result.truncated || result.unreadable) process.exitCode = 2;
    else if (result.severityCounts.high > 0) process.exitCode = 1;
  } catch {
    console.error('Workspace audit could not complete.');
    process.exitCode = 2;
  }
}
