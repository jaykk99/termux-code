#!/usr/bin/env node
import { verifyLocalProject } from '../lib/local-verification.mjs';
if (process.argv.length !== 2) {
  console.error('Usage: node bin/local-verify.mjs (from the local project directory)');
  process.exitCode=2;
} else {
  try {
    const result=await verifyLocalProject(process.cwd());
    console.log(JSON.stringify(result,null,2));
    process.exitCode=!result.complete?2:result.ok?0:1;
  } catch {console.error('Local verification could not complete.');process.exitCode=2;}
}
