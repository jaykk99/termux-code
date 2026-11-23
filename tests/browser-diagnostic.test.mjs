import { test } from 'node:test';
import assert from 'node:assert/strict';
import { browserDiagnostic } from '../lib/browser.mjs';

test('browser diagnostic reports real capability without launching Chromium', async () => {
  const diagnostic=await browserDiagnostic({gateway:'https://example.com'},
    {whichFn:async()=>null,WebSocketImpl:null});
  assert.deepEqual(diagnostic,{chromium:null,interactive:false,gateway:true});
});
test('browser diagnostic distinguishes installed Chromium from working CDP', async () => {
  const diagnostic=await browserDiagnostic({gateway:''},
    {whichFn:async(name)=>name==='chromium'?'/usr/bin/chromium':null,WebSocketImpl:null});
  assert.equal(diagnostic.chromium,'chromium');
  assert.equal(diagnostic.interactive,false);
  assert.equal(diagnostic.gateway,false);
});
