import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runPhone, validatePhoneAction } from '../lib/phone.mjs';
import { TOOL_SCHEMA, toolsForOpenAI, runTool } from '../lib/tools.mjs';

test('phone tool is discoverable by model', () => {
  assert.equal(TOOL_SCHEMA.find(t => t.name === 'phone')?.parameters?.properties?.action?.type, 'string');
  assert.ok(toolsForOpenAI().some(x => x.function.name === 'phone'));
});

test('phone actions reject malformed requests without invoking commands', async () => {
  let calls = 0;
  const deps = { execFn: async () => { calls++; throw new Error('should not execute'); } };
  for (const args of [
    {action:'send_sms', to:'; rm -rf /', message:'no'},
    {action:'send_sms', to:'+15551234567', message:''},
    {action:'compose_email', to:'bad-email',subject:'hello',message:'body'},
    {action:'compose_email', to:'a@example.com', subject:7,message:'body'},
    {action:'erase_phone'},
  ]) {
    const out = await runPhone(args, {}, deps);
    assert.match(out, /required|must|Valid|action/);
  }
  assert.equal(calls,0);
});

test('phone requires permission to send SMS even when command exists', async () => {
  const calls=[];
  const deps={execFn:async (cmd,args)=>{calls.push([cmd,args]);return {stdout:''};}};
  const result=await runPhone({action:'send_sms',to:'+15551234567',message:'Hello'},
    {approve:async()=>false},deps);
  assert.match(result,/Declined/);
  assert.equal(calls.some(x=>x[0]==='termux-sms-send'),false);
});

test('explicitly approved SMS passes safely through argv', async () => {
  const calls=[];
  const deps={execFn:async (cmd,args)=>{calls.push({cmd,args});return {stdout:''};}};
  const result=await runTool('phone',{action:'send_sms',to:'+15551234567',message:'Hello'},
    {root:process.cwd(),approve:async()=>true,phoneDeps:deps});
  assert.match(result,/submitted/);
  assert.deepEqual(calls.find(x=>x.cmd==='termux-sms-send')?.args,
    ['-n','+15551234567','Hello']);
});

test('email composer opens a draft and does not send mail', async () => {
  const calls=[];
  const out=await runPhone({action:'compose_email',to:'a@example.com',subject:'Hi',message:'Hello world'},
    {approve:async()=>true},{execFn:async(cmd,args)=>{calls.push({cmd,args});return {stdout:''};}});
  assert.match(out,/draft opened/);
  assert.ok(calls.some(x=>x.cmd==='termux-open-url' && x.args[0].startsWith('mailto:')));
  assert.ok(!calls.some(x=>x.cmd.includes('sendmail')));
});

test('status does not require phone permissions', async () => {
  const out=await runPhone({action:'status'},{},{execFn:async(cmd,args)=>{
    if(cmd!=='which')throw Error('unexpected');
    return {stdout:'/bin/'+args[0]};
  }});
  const parsed=JSON.parse(out);
  assert.equal(parsed.smsAvailable,true);
  assert.equal(parsed.emailComposerAvailable,true);
});
