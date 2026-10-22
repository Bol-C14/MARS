import test from 'node:test';
import assert from 'node:assert/strict';
import {explain} from '../ui/actions.js';
const r=(number,name,value)=>({kind:'register',number,name,value,write:false});
test('load explanation derives signed offset from instruction and preserves trace',()=>{
 const e={instruction:{op:'lw',binary:(35<<26)|(29<<21)|(8<<16)|65532},accesses:[r(29,'$sp',100),{kind:'memory',write:false,address:96,width:4,value:42},{...r(8,'$t0',42),write:true,before:0}],nextPC:4};
 const before=JSON.stringify(e), a=explain(e);
 assert.match(a.find(x=>x.title==='计算地址').detail,/\(-4\).*0x00000060/);
 assert.ok(a.findIndex(x=>x.title==='读取内存')<a.findIndex(x=>x.title==='写入'));
 assert.equal(JSON.stringify(e),before);
});
test('branch equality uses operands even when both paths could lead to same PC',()=>{
 const a=explain({instruction:{op:'beq',binary:(4<<26)|(8<<21)|(9<<16)},accesses:[r(8,'$t0',7),r(9,'$t1',7)],nextPC:4});
 assert.match(a.find(x=>x.title==='判断条件').detail,/→ 成立/);
});
test('waiting input never invents a write or output',()=>{
 const a=explain({instruction:{op:'syscall'},service:5,status:'waiting-input',accesses:[]});
 assert.ok(a.some(x=>x.title==='等待输入'));assert.ok(!a.some(x=>x.kind==='write'));
});
