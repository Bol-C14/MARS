import {escapeHTML as esc} from './model.js';
import {blankProject, normalizeProject, pathName, isSource, renamePath, removePath, mergeProject, readImports, projectZip} from './workspace.js';

export const DRAFT_KEY = 'mars-trace:project:v2';
const BACKUP_KEY = 'mars-trace:previous-project:v2';
const $ = id => document.getElementById(id);
export function projectManager(hooks) {
  let meta = blankProject(), timer, failed = false, replacing = false, draftLocked = false, previous = null;
  const snapshot = () => normalizeProject({...meta, ...hooks.snapshot()});
  const message = text => { $('workspace-status').textContent = text; };
  function save() {
    clearTimeout(timer);
    if (draftLocked) { message('旧草稿无法读取 · 未覆盖'); return false; }
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify(snapshot()));
      failed = false;
      message('已保存到此浏览器');
      return true;
    } catch {
      failed = true;
      message('未能保存 · 请导出工程');
      return false;
    }
  }
  function changed() {
    if (replacing) return;
    message('正在保存…');
    clearTimeout(timer);
    timer = setTimeout(save, 350);
  }
  async function apply(input, backup = true) {
    if (hooks.busy()) throw Error('请先暂停执行，等待当前操作完成。');
    const p = normalizeProject(input);
    draftLocked = false;
    clearTimeout(timer);
    if (backup) {
      previous = snapshot();
      try { localStorage.setItem(BACKUP_KEY, JSON.stringify(previous)); } catch {}
    }
    meta = p;
    replacing = true;
    try { await hooks.replace(p); } finally { replacing = false; }
    render();
    save();
  }
  function form(title, label, value, action, hint = '') {
    hooks.modal(title, `<form id="project-form"><label>${esc(label)}<input id="project-value" value="${esc(value)}" required autocomplete="off"></label>${hint ? `<p class="muted">${esc(hint)}</p>` : ''}<p id="project-error" role="alert"></p><div class="project-actions"><button type="button" id="project-cancel">取消</button><button class="primary">确定</button></div></form>`);
    $('project-cancel').onclick = () => $('modal').close();
    $('project-form').onsubmit = async e => {
      e.preventDefault();
      const submit = e.submitter;
      if (submit) submit.disabled = true;
      try { await action($('project-value').value); $('modal').close(); }
      catch (error) { if ($('project-error')) $('project-error').textContent = error.message; }
      finally { if (submit) submit.disabled = false; }
    };
    $('project-value').focus(); $('project-value').select();
  }
  function confirm(title, explanation, label, action) {
    hooks.modal(title, `<p class="project-explanation">${esc(explanation)}</p><p class="muted">当前工程会保留一份备份，可从“恢复上次管理操作”找回；重要代码请先导出。</p><p id="project-error" role="alert"></p><div class="project-actions"><button id="project-cancel">取消</button><button class="primary" id="project-confirm">${esc(label)}</button></div>`);
    $('project-cancel').onclick = () => $('modal').close();
    $('project-confirm').onclick = async e => {
      e.target.disabled = true;
      try { await action(); $('modal').close(); }
      catch (error) { $('project-error').textContent = error.message; e.target.disabled = false; }
    };
  }
  function create(folder = '', directory = false) {
    const prefix = folder ? folder + '/' : '';
    form(directory ? '新建文件夹' : '新建文件', '工程内路径', prefix + (directory ? '新文件夹' : 'new.s'), async value => {
      const name = pathName(value), p = snapshot();
      if (Object.hasOwn(p.files,name) || Object.hasOwn(p.data,name) || p.folders.includes(name)) throw Error('这个名称已经存在。');
      if (directory) p.folders.push(name);
      else if (isSource(name)) { p.files[name] = ''; p.activeFile = name; p.openTabs.push(name); if (!p.entry) p.entry = name; }
      else p.data[name] = '';
      await apply(p);
      if (!directory && !isSource(name)) setTimeout(() => hooks.editData(name));
    }, directory ? '文件夹可以嵌套；展开文件夹右侧的 ⋯ 可在其中新建。' : '小写 .s / .asm 是源码；.txt 等文件用作程序的虚拟输入。');
  }
  function download(bytes, name, type) {
    const url = URL.createObjectURL(new Blob([bytes], {type}));
    const link = document.createElement('a'); link.href = url; link.download = name;
    link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function downloadFile(name) {
    const p = snapshot(), text = p.files[name] ?? p.data[name];
    if (text != null) download(text, name.split('/').at(-1), 'text/plain;charset=utf-8');
  }
  function menu(path, folder) {
    const p = snapshot();
    hooks.modal(folder ? '文件夹 · ' + path : '文件 · ' + path, `<div class="file-actions">${folder ? '<button id="node-new-file">新建文件</button><button id="node-new-folder">新建子文件夹</button>' : '<button id="node-download">下载此文件</button>'}${isSource(path) && !folder ? `<button id="node-entry" ${p.entry===path ? 'disabled' : ''}>${p.entry===path ? '当前汇编入口' : '设为汇编入口'}</button>` : ''}<button id="node-rename">重命名／移动</button><button class="danger" id="node-delete">${folder ? '删除文件夹及其内容' : '删除文件'}</button></div><p class="muted">重命名／移动时填写完整工程路径，例如 src/main.s。</p>`);
    if (folder) {
      $('node-new-file').onclick = () => create(path);
      $('node-new-folder').onclick = () => create(path, true);
    } else $('node-download').onclick = () => downloadFile(path);
    if ($('node-entry')) $('node-entry').onclick = async () => { try { await apply({...snapshot(),entry:path}); $('modal').close(); } catch(e) {hooks.notify(e.message);} };
    $('node-rename').onclick = () => form('重命名／移动', '新路径', path, value => apply(renamePath(snapshot(), path, value)));
    $('node-delete').onclick = () => {
      const count = [...Object.keys(p.files),...Object.keys(p.data)].filter(n => n === path || n.startsWith(path+'/')).length;
      confirm('确认删除', `删除 ${path}${folder ? ` 及其中 ${count} 个文件` : ''}？`, '删除', () => apply(removePath(snapshot(), path)));
    };
  }
  const collapsed = new Set();
  function render() {
    const p = snapshot();
    $('project-title').textContent = p.name;
    $('project-title').title = '修改工程名称';
    const rows = parent => {
      const base = parent ? parent + '/' : '';
      const immediate = name => name.startsWith(base) && !name.slice(base.length).includes('/');
      const directories = p.folders.filter(immediate);
      const paths = [...Object.keys(p.files),...Object.keys(p.data)].filter(immediate).sort();
      return directories.map(path => `<li><details data-folder="${esc(path)}" ${collapsed.has(path) ? '' : 'open'}><summary><span class="folder-name">${esc(path.slice(base.length))}</span><button class="tree-menu" data-node="${esc(path)}" data-directory="true" title="管理文件夹" aria-label="管理文件夹 ${esc(path)}">⋯</button></summary><ul>${rows(path) || '<li class="tree-empty">空文件夹</li>'}</ul></details></li>`).join('') + paths.map(path => `<li class="tree-row ${path===p.activeFile ? 'active' : ''}"><button class="tree-open" ${isSource(path) ? 'data-file' : 'data-data'}="${esc(path)}" title="${esc(path)}"><span aria-hidden="true">${isSource(path) ? '◇' : '▤'}</span><span class="tree-name">${esc(path.slice(base.length))}</span>${path===p.entry ? '<small class="entry-badge">入口</small>' : ''}</button><button class="tree-menu" data-node="${esc(path)}" title="管理文件" aria-label="管理文件 ${esc(path)}">⋯</button></li>`).join('');
    };
    $('files').innerHTML = `<ul class="file-tree" aria-label="工程文件树">${rows('') || '<li class="tree-empty">工程为空，点击 ＋ 新建文件或打开工程。</li>'}</ul>`;
    $('files').querySelectorAll('[data-file]').forEach(b => b.onclick = () => hooks.openFile(b.dataset.file));
    $('files').querySelectorAll('[data-data]').forEach(b => b.onclick = () => hooks.editData(b.dataset.data));
    $('files').querySelectorAll('[data-node]').forEach(b => b.onclick = e => { e.preventDefault(); e.stopPropagation(); menu(b.dataset.node, b.dataset.directory==='true'); });
    $('files').querySelectorAll('details').forEach(d => d.ontoggle = () => { if (d.open) collapsed.delete(d.dataset.folder); else collapsed.add(d.dataset.folder); });
    $('entry-file').innerHTML = Object.keys(p.files).map(name => `<option value="${esc(name)}" ${name===p.entry ? 'selected' : ''}>${esc(name)}</option>`).join('') || '<option>暂无源码</option>';
    $('entry-file').disabled = !p.entry;
    $('export-file').disabled = !p.activeFile;
    try { $('restore-project').disabled = !previous && !localStorage.getItem(BACKUP_KEY); } catch { $('restore-project').disabled = !previous; }
  }
  function importDialog(mode = 'replace') {
    hooks.modal(mode==='replace' ? '打开工程' : '添加文件', `<p>${mode==='replace' ? '用你选择的内容替换当前工程，演示文件不会混入。' : '把文件添加到当前工程，遇到同名文件时会先询问。'}</p><p class="muted">支持 .s / .asm、UTF-8 输入文件、MARS 工程 JSON 或 ZIP；可多选。最多 200 个文件、1.5 MB 文本。</p><div class="project-actions"><button id="choose-folder">选择整个文件夹</button><button class="primary" id="choose-files">选择文件／工程包</button></div>`);
    $('choose-files').onclick = () => { $('upload').dataset.mode = mode; $('upload').value=''; $('upload').click(); };
    $('choose-folder').onclick = () => { $('folder-upload').dataset.mode = mode; $('folder-upload').value=''; $('folder-upload').click(); };
  }
  async function receive(e) {
    const selected = [...e.target.files], mode = e.target.dataset.mode;
    e.target.value = '';
    if (!selected.length) return;
    try {
      const incoming = await readImports(selected);
      if (selected.length===1 && !/\.(json|zip)$/i.test(selected[0].name)) incoming.name = selected[0].name.replace(/\.[^.]+$/, '');
      if (mode==='replace') return confirm('替换当前工程', `将打开 ${Object.keys(incoming.files).length} 个源码文件、${Object.keys(incoming.data).length} 个输入文件。当前工程中的其他文件将移出工作区。`, '替换工程', () => apply(incoming));
      const p = snapshot(), conflicts = [...Object.keys(incoming.files), ...Object.keys(incoming.data)].filter(n => Object.hasOwn(p.files,n) || Object.hasOwn(p.data,n));
      if (conflicts.length) return confirm('存在同名文件', '以下文件会被覆盖：' + conflicts.join('、'), '覆盖同名并添加', () => apply(mergeProject(snapshot(), incoming, true)));
      await apply(mergeProject(p,incoming));
      $('modal').close();
    } catch(error) { hooks.modal('导入未完成', `<p role="alert">${esc(error.message)}</p><p>当前工程未改变，请检查文件后重试。</p>`); }
  }
  $('new-project').onclick = () => confirm('新建空白工程', '清空当前工作区，创建一个不带演示代码的 main.s。', '新建工程', () => apply(blankProject()));
  $('project-title').onclick = () => form('工程名称', '名称', snapshot().name, value => { if (!value.trim()) throw Error('请输入名称。'); return apply({...snapshot(),name:value.trim()}); });
  $('new-file').onclick = () => create();
  $('new-folder').onclick = () => create('',true);
  $('import').onclick = () => importDialog();
  $('add-import').onclick = () => importDialog('add');
  $('upload').onchange = receive;
  $('folder-upload').onchange = receive;
  $('save-local').onclick = () => { save(); hooks.notify(failed ? '浏览器存储不可用，请导出工程保存。' : '源码已保存到此浏览器；换设备前请导出工程。', {transient: true}); };
  $('save').onclick = () => {
    const p = snapshot();
    hooks.modal('导出工程', '<p>保存到电脑后可重新导入，或发给老师。源码、输入文件、目录和汇编入口都会保留。</p><div class="file-actions"><button id="download-zip">下载 ZIP（包含原始文件）</button><button id="download-json">下载 MARS 工程 JSON</button></div>');
    const basename = p.name.replace(/[\\/:*?"<>|]/g,'-') || 'mars-project';
    $('download-zip').onclick = () => { download(projectZip(p),basename+'.zip','application/zip'); $('modal').close(); };
    $('download-json').onclick = () => { download(JSON.stringify(p,null,2),basename+'.json','application/json'); $('modal').close(); };
  };
  $('export-file').onclick = () => downloadFile(hooks.snapshot().activeFile);
  $('entry-file').onchange = async e => { try { await apply({...snapshot(),entry:e.target.value}); } catch(error) {hooks.notify(error.message);render();} };
  $('restore-project').onclick = () => {
    try { const restore=previous || normalizeProject(JSON.parse(localStorage.getItem(BACKUP_KEY))); confirm('恢复上次管理操作前的工程', `恢复“${restore.name}”的文件。当前内容会成为下一份备份。`, '恢复', () => apply(restore)); }
    catch(error) { hooks.notify(error.message); }
  };
  document.addEventListener('keydown', e => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase()==='s' && !e.altKey && !e.shiftKey) { e.preventDefault(); $('save-local').click(); }
  },true);
  window.addEventListener('pagehide', save);
  window.addEventListener('beforeunload', e => { if (!save()) {e.preventDefault(); e.returnValue='';} });
  return {
    render, changed, save, snapshot, apply,
    entry: () => meta.entry,
    tabs: () => meta.openTabs.filter(n => Object.hasOwn(hooks.snapshot().files,n)),
    opened: name => { if (!meta.openTabs.includes(name)) meta.openTabs.push(name); changed(); },
    closeTab: name => { const active=hooks.snapshot().activeFile; meta.openTabs=meta.openTabs.filter(n=>n!==name); hooks.selectActive(active===name ? meta.openTabs.at(-1)||'' : active); render(); save(); },
    example: (p, name) => confirm('打开示例', '示例会替换当前工程。可以通过“恢复上次管理操作”找回当前内容。', '打开示例', async () => { await apply({...p,name}); await hooks.assemble(); }),
    async start() {
      let p;
      try {
        const saved = localStorage.getItem(DRAFT_KEY);
        if (saved) p=normalizeProject(JSON.parse(saved));
      } catch { draftLocked=true; render(); hooks.selectActive(''); hooks.notify('之前的浏览器草稿无法读取，未覆盖旧草稿。可打开工程恢复，或新建工程重新开始。'); return; }
      await apply(p || blankProject(),false);
      hooks.notify(p ? '已恢复此浏览器中的工程；点击“汇编”开始执行。' : '空白工程已就绪：可直接写代码，或“打开工程”导入自己的文件。');
    },
  };
}
