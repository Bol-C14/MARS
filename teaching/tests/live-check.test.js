import test from 'node:test';
import assert from 'node:assert/strict';
import {liveCheck} from '../ui/live-check.js';

const wait=ms=>new Promise(r=>setTimeout(r,ms));
const doc={length:100,lineAt:p=>({number:Math.floor(p/10)+1}),toString:()=>'text'};
const changes=(from,to=from)=>({mapPos:p=>p,iterChangedRanges:f=>f(from,to,from,to)});
function setup(over={}){
 const sent=[],shown=[],scoped=[];
 const live=liveCheck({post:async b=>{sent.push(b);return {status:'ok',diagnostics:[]}},current:()=>({file:'a.s',doc}),scope:()=>({files:{'a.s':'text'},entry:'a.s'}),ready:()=>true,held:()=>false,showLines:(l,d)=>shown.push(l),showScope:(d,f)=>scoped.push(f),lineDelay:2,fullDelay:15,...over});
 return {live,sent,shown,scoped};
}
test('a pause checks the changed lines, a longer one the scope',async()=>{
 const {live,sent,shown,scoped}=setup();
 live.edited(changes(5));live.edited(changes(25));await wait(30);
 assert.deepEqual(sent.map(b=>b.command),['line','full']);assert.deepEqual(sent[0].lines,[1,2,3]);assert.deepEqual(shown,[[1,2,3]]);assert.equal(scoped.length,1);
});
test('unchanged text is not checked twice and open basic errors hold the full check',async()=>{
 const a=setup();a.live.edited(changes(5));await wait(30);a.live.edited(changes(5));await wait(30);
 assert.equal(a.sent.filter(b=>b.command==='full').length,1);
 const b=setup({held:()=>true});b.live.edited(changes(5));await wait(30);
 assert.equal(b.sent.filter(x=>x.command==='full').length,0);
});
test('an answer about text that changed since is dropped',async()=>{
 let answer;const shown=[];
 const {live}=setup({post:()=>new Promise(r=>{answer=r}),showLines:l=>shown.push(l),fullDelay:1000});
 live.edited(changes(5));await wait(10);live.edited(changes(5));answer({status:'ok',diagnostics:[]});await wait(1);
 assert.deepEqual(shown,[]);live.reset();
});
test('a change of file drops what is on its way',async()=>{
 const {live,sent}=setup();live.edited(changes(5));live.reset();await wait(30);assert.equal(sent.length,0);
});
test('one request flies per kind and only the newest waits',async()=>{
 const answers=[],sent=[];
 const {live}=setup({post:b=>{sent.push(b);return new Promise(r=>answers.push(r))},lineDelay:1,fullDelay:1000});
 live.edited(changes(5));await wait(5);live.edited(changes(15));await wait(5);live.edited(changes(25));await wait(5);
 assert.equal(sent.length,1);answers[0]({status:'ok',diagnostics:[]});await wait(5);
 assert.equal(sent.length,2);assert.deepEqual(sent[1].lines,[3]);live.reset();
});
test('waiting while a program runs, and undetermined answers change nothing',async()=>{
 let going=false;const a=setup({ready:()=>!going});
 going=true;a.live.edited(changes(5));await wait(30);assert.equal(a.sent.filter(b=>b.command==='full').length,0);a.live.reset();
 const shown=[];const b=setup({post:async()=>({status:'undetermined',diagnostics:[]}),showLines:l=>shown.push(l)});
 b.live.edited(changes(5));await wait(30);assert.deepEqual(shown,[]);
});
test('no checker turns the feature off; a failed try does not',async()=>{
 let tries=0;const a=setup({post:async()=>{tries++;return null},fullDelay:1000});
 a.live.edited(changes(5));await wait(10);a.live.edited(changes(5));await wait(10);a.live.reset();assert.equal(tries,1);assert.equal(a.live.enabled(),false);
 const b=setup({post:async()=>{throw Error('offline')},fullDelay:1000});b.live.edited(changes(5));await wait(10);b.live.reset();assert.equal(b.live.enabled(),true);
});
