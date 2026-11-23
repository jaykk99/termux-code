import { test } from 'node:test';
import assert from 'node:assert/strict';
import { turn } from '../bin/termux-code.mjs';

const model={id:'test',provider:'mock',auth:'none'};
function reply(text='',calls=[]) {
  return {text,toolCalls:calls,assistantMessage:{role:'assistant',content:text||null,
    ...(calls.length?{tool_calls:calls.map(c=>({id:c.id,type:'function',function:{name:c.name,arguments:JSON.stringify(c.args)}}))}:{})}};
}
function call(name,args,id='call-1') {return {id,name,args};}
async function run(messages,responses,extras={}) {
  let count=0;
  const checkpoints=[];
  const agent={verify:{enabled:false},checkpoint:async()=>{checkpoints.push(messages.length);},...extras};
  const result=await turn(model,messages,{closed:false,question:(_q,cb)=>cb('y')},'/tmp',
    async()=>responses[count++]||reply('done'),{},agent);
  return {result,count,checkpoints,messages};
}
test('task tool delegates through injected sub-agent and checkpoints result',async()=>{
  const messages=[{role:'system',content:'sys'},{role:'user',content:'Delegate research to a subagent'}];
  let invoked=0;
  const r=await run(messages,[reply('',[call('task',{prompt:'Inspect API docs'})]),reply('Completed delegation.')],{
    spawn:async prompt=>{invoked++;assert.equal(prompt,'Inspect API docs');return 'Inspected docs';}
  });
  assert.equal(invoked,1);
  assert.equal(r.result,'Completed delegation.');
  assert.ok(r.checkpoints.length>=1);
  assert.ok(messages.some(m=>m.role==='tool'&&m.content.includes('Inspected docs')));
});
test('MCP tool uses injected servers instead of an undefined outer variable',async()=>{
  const messages=[{role:'system',content:'sys'},{role:'user',content:'Check remote server'}];
  const servers=[{name:'demo'}];
  const r=await run(messages,[reply('',[call('mcp__demo__lookup',{id:'a'})]),reply('Lookup completed.')],{
    mcpServers:servers,mcpRunner:async (received,name,args)=>{
      assert.equal(received,servers);assert.equal(name,'mcp__demo__lookup');assert.equal(args.id,'a');return 'Result from MCP';
    }
  });
  assert.equal(r.result,'Lookup completed.');
  assert.ok(messages.some(m=>m.role==='tool'&&m.content.includes('Result from MCP')));
});
test('coding task does not stop at a plan when no tools have run',async()=>{
  const messages=[{role:'system',content:'sys'},{role:'user',content:'Build a multi-file project'}];
  const names=[];
  const r=await run(messages,[
    reply('I will write the files now.'),
    reply('',[call('project_map',{})]),
    reply('',[call('write_file',{path:'index.js',content:'ok'},'call-2')]),
    reply('Implemented the files.')
  ],{
    toolRunner:async(name)=>{names.push(name);return name==='write_file'?'Wrote 1 lines to index.js.':'index.js\\npackage.json';}
  });
  assert.equal(r.result,'Implemented the files.');
  assert.deepEqual(names,['project_map','write_file']);
  assert.ok(messages.some(m=>m.role==='user'&&String(m.content).includes('[Task completion check]')));
  assert.ok(r.checkpoints.length>=3);
});
test('repeated promises with no tool calls do not falsely report implementation success',async()=>{
  const messages=[{role:'system',content:'sys'},{role:'user',content:'Fix the repository code'}];
  const r=await run(messages,[reply('I will fix this.'),reply('Working on it.'),reply('Done.')]);
  assert.equal(r.result,null);
  assert.equal(r.count,3);
});
