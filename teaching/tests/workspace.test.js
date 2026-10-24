import test from 'node:test';
import assert from 'node:assert/strict';
import {File} from 'node:buffer';
import {zipSync,strToU8} from 'fflate';
import {blankProject,normalizeProject,renamePath,removePath,mergeProject,readImports,projectZip,pathName} from '../ui/workspace.js';
const project=()=>normalizeProject({name:'练习',files:{'main.s':'.text\nmain: nop\n','src/helper.s':'.text\nhelper: nop\n'},data:{'input.txt':'1\n2\n'},folders:['empty'],entry:'src/helper.s',activeFile:'src/helper.s'});
test('ZIP roundtrip preserves paths, source, UTF-8 inputs, empty folders and entry',async()=>{
 const p=project(); const restored=await readImports([new File([projectZip(p)],'练习.zip')]);
 assert.deepEqual(restored.files,p.files);assert.deepEqual(restored.data,p.data);assert.deepEqual(restored.folders,p.folders);assert.equal(restored.entry,p.entry);assert.equal(restored.name,p.name);
});
test('JSON restores both old and current exports',async()=>{
 for(const p of [project(),{version:1,files:{'main.s':'# old'},data:{'x.txt':'旧文件'}}]){
  const q=await readImports([new File([JSON.stringify(p)],'工程.json')]);assert.deepEqual(q.files,p.files);assert.deepEqual(q.data,p.data);
 }
});
test('folder rename moves every child and its editor and entry references',()=>{
 const p=renamePath(project(),'src','课程/函数');
 assert.equal(p.files['课程/函数/helper.s'],'.text\nhelper: nop\n');assert.equal(p.entry,'课程/函数/helper.s');assert.equal(p.activeFile,p.entry);assert.ok(p.openTabs.includes(p.entry));assert.ok(!p.folders.includes('src'));
});
test('destructive collisions and folder cycles leave original input untouched',()=>{
 const p=project(), before=JSON.stringify(p);
 assert.throws(()=>renamePath(p,'src','src/nested'));assert.throws(()=>renamePath(p,'main.s','src/helper.s'));assert.throws(()=>renamePath(p,'main.s','main.txt'));assert.equal(JSON.stringify(p),before);
});
test('deleting current folder chooses a remaining source without recreating deleted files',()=>{
 const p=removePath(project(),'src');assert.equal(p.entry,'main.s');assert.equal(p.activeFile,'main.s');assert.ok(!('src/helper.s' in p.files));
 const empty=removePath(removePath(p,'main.s'),'input.txt');assert.equal(empty.entry,'');assert.deepEqual(empty.files,{});
});
test('explicitly closed editor remains closed when saving and restoring',()=>{
 const p=normalizeProject({...project(),activeFile:'',openTabs:[]});assert.equal(p.activeFile,'');assert.deepEqual(p.openTabs,[]);
});
test('merge needs explicit overwrite and validates folder/file conflicts',()=>{
 const p=project(),incoming=normalizeProject({files:{'main.s':'new'}});
 assert.throws(()=>mergeProject(p,incoming));assert.equal(mergeProject(p,incoming,true).files['main.s'],'new');
 assert.throws(()=>mergeProject(p,normalizeProject({files:{},data:{src:'not a directory'}})));
});
test('regular file multi-import preserves folder paths and rejects duplicates atomically',async()=>{
 const p=await readImports([new File(['.text'],'other.s'),new File(['hello'],'input.txt')]);assert.equal(p.entry,'other.s');assert.equal(p.data['input.txt'],'hello');
 await assert.rejects(()=>readImports([new File(['a'],'same.s'),new File(['b'],'same.s')]));
});
test('reject unsafe paths, invalid text, malformed project and oversized ZIP before extraction',async()=>{
 for(const p of ['/etc/passwd','../main.s','a/../main.s','a//main.s','C:\\main.s','__proto__/x.s'])assert.throws(()=>pathName(p));
 assert.throws(()=>normalizeProject({files:{'a.s':'x'},folders:['a.s']}));
 assert.throws(()=>normalizeProject({files:{'a.s':'x'},data:{'a.s':'x'}}));
 await assert.rejects(()=>readImports([new File([new Uint8Array([255,254])],'bad.s')]));
 const bytes=zipSync({'big.txt':new Uint8Array(1_600_000)},{level:6});
 await assert.rejects(()=>readImports([new File([bytes],'too-big.zip')]));
 await assert.rejects(()=>readImports([new File([zipSync({'../outside.s':strToU8('x')})],'unsafe.zip')]));
});
import {assemblyScope,labelsIn,referencesIn,scopeHints} from '../ui/workspace.js';
const one=v=>`.text\n.globl main\nmain:\nli $a0,${v}\nli $v0,1\nsyscall\n`;
const exercises=()=>normalizeProject({files:{'hello.s':one(1),'课程/hexOut.s':'.text\n.globl main # entry\nmain: jal helper\n','课程/helper.s':'.text\n.globl helper\nhelper: jr $ra\n','课程/other.s':one(3)},activeFile:'课程/hexOut.s',entry:'hello.s'});
const mode=(p,m,extra={})=>normalizeProject({...p,assembly:{mode:m,files:[],...extra}});
test('legacy projects open in auto mode; the first draft names still read',()=>{
 assert.deepEqual(exercises().assembly,{mode:'auto',files:[]});
 assert.equal(normalizeProject({...exercises(),assembly:{mode:'joint'}}).assembly.mode,'manual');
 assert.equal(normalizeProject({...exercises(),assembly:{mode:'current'}}).assembly.mode,'single');
});
test('auto: the open file with main is the only main source and links what it uses',()=>{
 assert.deepEqual(assemblyScope(exercises(),'课程/hexOut.s'),{mode:'auto',files:['课程/hexOut.s','课程/helper.s'],entry:'课程/hexOut.s'});
 assert.deepEqual(assemblyScope(exercises(),'hello.s'),{mode:'auto',files:['hello.s'],entry:'hello.s'});
});
test('auto: an open file without main finds the one main in its folder, links transitively',()=>{
 const p=normalizeProject({files:{'lab/main.s':'.text\n.globl main\nmain: jal task1\n','lab/task1.s':'.text\n.globl task1\ntask1: jal printChar\n','lib/io.s':'.text\n.globl printChar\nprintChar: jr $ra\n','solo.s':'.text\nli $v0,10\nsyscall\n'}});
 assert.deepEqual(assemblyScope(p,'lab/task1.s'),{mode:'auto',files:['lab/main.s','lab/task1.s','lib/io.s'],entry:'lab/main.s'});
 assert.deepEqual(assemblyScope(p,'solo.s'),{mode:'auto',files:['solo.s'],entry:'solo.s'},'no main anywhere: the open file runs alone');
});
test('auto: several mains in the folder of a file without main is the only error',()=>{
 assert.match(assemblyScope(exercises(),'课程/helper.s').error,/多个文件定义了 main（课程\/hexOut\.s、课程\/other\.s）/);
 const twice=normalizeProject({files:{'main.s':'.text\n.globl main\nmain: jal f\n','a/f.s':'.text\n.globl f\nf: jr $ra\n','b/f.s':'.text\n.globl f\nf: jr $ra\n'}});
 assert.match(assemblyScope(twice,'main.s').error,/f 同时定义在 a\/f\.s、b\/f\.s/);
});
test('single and manual scopes use exactly the open file or the chosen files',()=>{
 assert.deepEqual(assemblyScope(mode(exercises(),'single'),'课程/hexOut.s'),{mode:'single',files:['课程/hexOut.s'],entry:'课程/hexOut.s'});
 const p=mode(exercises(),'manual',{files:['课程/hexOut.s','课程/helper.s','missing.s','课程/helper.s']});
 assert.deepEqual(p.assembly.files,['课程/hexOut.s','课程/helper.s']);
 assert.deepEqual(assemblyScope(p,'hello.s'),{mode:'manual',files:['课程/hexOut.s','课程/helper.s'],entry:'课程/hexOut.s'});
 assert.equal(assemblyScope(normalizeProject({...p,entry:'课程/helper.s'}),'').entry,'课程/helper.s');
 assert.match(assemblyScope(mode(exercises(),'manual'),'hello.s').error,/还没有勾选/);
 assert.match(assemblyScope(exercises(),'').error,/请先打开/);
});
test('manual selection follows renames and deletions and survives ZIP and JSON',async()=>{
 let p=normalizeProject({...mode(exercises(),'manual',{files:['课程/hexOut.s','课程/helper.s']}),entry:'课程/hexOut.s'});
 p=renamePath(p,'课程','src');assert.deepEqual(p.assembly.files,['src/hexOut.s','src/helper.s']);
 assert.deepEqual(removePath(p,'src/helper.s').assembly.files,['src/hexOut.s']);
 const zip=await readImports([new File([projectZip(p)],'p.zip')]);assert.deepEqual(zip.assembly,p.assembly);assert.equal(zip.entry,p.entry);
 const json=await readImports([new File([JSON.stringify(p)],'p.json')]);assert.deepEqual(json.assembly,p.assembly);
 const merged=mergeProject(p,normalizeProject({files:{'extra.s':'.text'},assembly:{mode:'manual',files:['extra.s']}}));assert.deepEqual(merged.assembly,p.assembly);
});
test('labels and references are read from text, ignoring comments and strings',()=>{
 const l=labelsIn('.globl main, helper\nmain: a: nop # b:\n.asciiz "c: d"\n');
 assert.deepEqual([...l.defined],['main','a']);assert.deepEqual([...l.globals],['main','helper']);
 assert.deepEqual([...referencesIn('loop: beq $t0,$zero,done # jal x\nla $a0, 0x10($sp)\n.word table, 4\n.asciiz "jal y"\n.globl z\n')],['done','table']);
});
test('scope diagnostics name the files involved and the way out',()=>{
 const p=mode(exercises(),'manual',{files:['hello.s','课程/hexOut.s']});
 const [dup,other]=scopeHints([{message:'"main" already defined as global in a different file.'},{message:'Something else'}],p,assemblyScope(p,''));
 assert.match(dup,/hello\.s、课程\/hexOut\.s 都定义了全局标签 main/);assert.equal(other,'');
 const single=mode(exercises(),'single'),[missing]=scopeHints([{message:'Symbol "helper" not found in symbol table.'}],single,assemblyScope(single,'课程/hexOut.s'));
 assert.match(missing,/helper 定义在 课程\/helper\.s，单文件汇编不会加入它/);
 const local=normalizeProject({files:{'main.s':'.text\nmain: jal f\n','f.s':'.text\nf: jr $ra\n'}});
 assert.match(scopeHints([{message:'Symbol "f" not found in symbol table.'}],local,assemblyScope(local,'main.s'))[0],/没有用 \.globl f 声明为全局标签/);
 assert.equal(scopeHints([{message:'Symbol "nowhere" not found in symbol table.'}],single,assemblyScope(single,'hello.s'))[0],'');
});
