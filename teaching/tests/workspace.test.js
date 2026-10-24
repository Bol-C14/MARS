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
