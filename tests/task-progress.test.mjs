import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTaskProgress, observeTaskTool, continuationInstruction, requestContinuation } from '../lib/task-progress.mjs';

test('plain questions finish without forced file edits', () => {
  const state = createTaskProgress('What is a JavaScript promise?');
  assert.equal(continuationInstruction(state), null);
});

test('long coding tasks inspect and edit before declaring completion', () => {
  const state = createTaskProgress('Build a multi-file web app and fix the repo');
  assert.match(continuationInstruction(state), /Inspect the workspace/);
  observeTaskTool(state,'list_dir',{path:'.'},'src/\npackage.json');
  assert.match(continuationInstruction(state), /No successful file edits/);
  observeTaskTool(state,'write_file',{path:'src/app.mjs'},'Wrote 12 lines to src/app.mjs.');
  assert.equal(continuationInstruction(state), null);
});

test('fake or denied writes are not counted as completed implementation', () => {
  const state = createTaskProgress('Fix the project files');
  observeTaskTool(state,'read_file',{path:'x'},'contents');
  observeTaskTool(state,'write_file',{path:'x'},'Declined by the user.');
  assert.equal(state.changed,false);
  observeTaskTool(state,'edit_file',{path:'x'},'Old string not found. Nothing was written.');
  assert.equal(state.changed,false);
});

test('multi-url research continues until each URL is attempted', () => {
  const state = createTaskProgress('Read https://example.com/a and https://example.org/b then summarize');
  assert.match(continuationInstruction(state), /example.com/);
  observeTaskTool(state,'fetch_url',{url:'https://example.com/a'},'page content');
  assert.match(continuationInstruction(state), /example.org/);
  observeTaskTool(state,'browser',{action:'read',url:'https://example.org/b'},'Browser failed');
  assert.equal(continuationInstruction(state),null);
});

test('continuation is bounded and preserves transcript', () => {
  const state = createTaskProgress('Implement a CLI app');
  const messages = [{role:'user',content:'Implement a CLI app'}];
  assert.equal(requestContinuation(state,messages),true);
  assert.equal(requestContinuation(state,messages),true);
  assert.equal(requestContinuation(state,messages),false);
  assert.equal(messages.length,3);
  assert.match(messages[2].content,/Task completion check/);
});

test('verification attempts are noted separately from changes', () => {
  const state = createTaskProgress('Repair the tests in this repository');
  observeTaskTool(state,'bash',{command:'npm test'},'exit code: 1');
  assert.equal(state.tested,true);
  assert.equal(state.changed,false);
});
