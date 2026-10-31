import {escapeHTML as esc} from './model.js';
import {blankProject, normalizeProject, pathName, isSource, renamePath, removePath, mergeProject, underFolder, readImports, projectZip, assemblyScope, MAX_BYTES, MAX_FILES} from './workspace.js';
import {put, get} from './store.js';

export const DRAFT_KEY = 'mars-trace:project:v2';
const BACKUP_KEY = 'mars-trace:previous-project:v2';
const $ = id => document.getElementById(id);
export function projectManager(hooks) {
  let meta = blankProject(), timer, failed = false, replacing = false, draftLocked = false, previous = null, hasBackup = false, saving = Promise.resolve();
  const snapshot = () => normalizeProject({...meta, ...hooks.snapshot()});
  const message = text => { $('workspace-status').textContent = text; };
  function save() {
    clearTimeout(timer);
    if (draftLocked) { message('旧草稿无法读取 · 未覆盖'); return false; }
    const done = ok => { failed = !ok; message(ok ? '已保存到此浏览器' : '未能保存 · 请导出工程'); };
    try { saving = put(DRAFT_KEY, snapshot()).then(() => done(true), () => done(false)); }
    catch { done(false); }
    return !failed;
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
      hasBackup = true;
      put(BACKUP_KEY, previous).catch(() => {});
    }
    meta = p;
    replacing = true;
    try { await hooks.replace(p); } finally { replacing = false; }
    render();
    save();
  }
  // Changing the assembly scope keeps the loaded program and its history; the
  // IDE then says the program is out of date instead of replacing anything.
  function setAssembly(patch, entry = meta.entry) {
    if (hooks.busy()) { hooks.notify('请先暂停执行，再修改汇编范围。'); render(); return; }
    const current = hooks.snapshot().activeFile, assembly = {...meta.assembly, ...patch};
    // A first manual scope starts from what auto assembly would use now.
    if (patch.mode === 'manual' && !assembly.files.length) {
      const auto = assemblyScope({...snapshot(), assembly: {mode: 'auto', files: []}}, current);
      if (!auto.error) { assembly.files = auto.files; entry = auto.entry; }
      else if (current && isSource(current)) { assembly.files = [current]; entry = current; }
    }
    meta = normalizeProject({...snapshot(), assembly, entry});
    render(); changed(); hooks.scopeChanged();
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
    hooks.modal(folder ? '文件夹 · ' + path : '文件 · ' + path, `<div class="file-actions">${folder ? '<button id="node-new-file">新建文件</button><button id="node-new-folder">新建子文件夹</button>' : '<button id="node-download">下载此文件</button>'}${isSource(path) && !folder && p.assembly.mode==='manual' ? `<button id="node-entry" ${p.entry===path && p.assembly.files.includes(path) ? 'disabled' : ''}>${p.entry===path && p.assembly.files.includes(path) ? '当前汇编入口' : '设为汇编入口'}</button>` : ''}<button id="node-rename">重命名／移动</button><button class="danger" id="node-delete">${folder ? '删除文件夹及其内容' : '删除文件'}</button></div><p class="muted">重命名／移动时填写完整工程路径，例如 src/main.s。</p>`);
    if (folder) {
      $('node-new-file').onclick = () => create(path);
      $('node-new-folder').onclick = () => create(path, true);
    } else $('node-download').onclick = () => downloadFile(path);
    if ($('node-entry')) $('node-entry').onclick = () => { setAssembly({files:[...new Set([...meta.assembly.files,path])]}, path); $('modal').close(); };
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
    // A manual scope shows a checkbox per source and the entry among them;
    // auto and single assembly need neither.
    const joint = p.assembly.mode === 'manual', chosen = p.assembly.files;
    const scopeEntry = chosen.includes(p.entry) ? p.entry : chosen.includes('main.s') ? 'main.s' : chosen[0];
    const rows = parent => {
      const base = parent ? parent + '/' : '';
      const immediate = name => name.startsWith(base) && !name.slice(base.length).includes('/');
      const directories = p.folders.filter(immediate);
      const paths = [...Object.keys(p.files),...Object.keys(p.data)].filter(immediate).sort();
      return directories.map(path => `<li><details data-folder="${esc(path)}" ${collapsed.has(path) ? '' : 'open'}><summary><span class="folder-name">${esc(path.slice(base.length))}</span><button class="tree-menu" data-node="${esc(path)}" data-directory="true" title="管理文件夹" aria-label="管理文件夹 ${esc(path)}">⋯</button></summary><ul>${rows(path) || '<li class="tree-empty">空文件夹</li>'}</ul></details></li>`).join('') + paths.map(path => `<li class="tree-row ${path===p.activeFile ? 'active' : ''} ${joint && chosen.includes(path) ? 'joined' : ''}">${joint && isSource(path) ? `<input type="checkbox" class="joint-pick" data-joint="${esc(path)}" ${chosen.includes(path) ? 'checked' : ''} aria-label="${esc(path)} 参与汇编" title="参与汇编">` : ''}<button class="tree-open" ${isSource(path) ? 'data-file' : 'data-data'}="${esc(path)}" title="${esc(path)}"><span aria-hidden="true">${isSource(path) ? '◇' : '▤'}</span><span class="tree-name">${esc(path.slice(base.length))}</span>${joint && path===scopeEntry ? '<small class="entry-badge">入口</small>' : ''}</button><button class="tree-menu" data-node="${esc(path)}" title="管理文件" aria-label="管理文件 ${esc(path)}">⋯</button></li>`).join('');
    };
    $('files').innerHTML = `<ul class="file-tree" aria-label="工程文件树">${rows('') || '<li class="tree-empty">工程为空，点击 ＋ 新建文件，或从“工程”菜单导入。</li>'}</ul>`;
    $('files').querySelectorAll('[data-file]').forEach(b => b.onclick = () => hooks.openFile(b.dataset.file));
    $('files').querySelectorAll('[data-data]').forEach(b => b.onclick = () => hooks.editData(b.dataset.data));
    $('files').querySelectorAll('[data-node]').forEach(b => b.onclick = e => { e.preventDefault(); e.stopPropagation(); menu(b.dataset.node, b.dataset.directory==='true'); });
    $('files').querySelectorAll('details').forEach(d => d.ontoggle = () => { if (d.open) collapsed.delete(d.dataset.folder); else collapsed.add(d.dataset.folder); });
    $('files').querySelectorAll('[data-joint]').forEach(c => c.onchange = () => setAssembly({files: c.checked ? [...chosen, c.dataset.joint] : chosen.filter(n => n !== c.dataset.joint)}));
    $('joint-settings').hidden = !joint;
    const scope = assemblyScope(p, p.activeFile);
    $('assembly-mode-name').textContent = {auto: '自动汇编', single: '单文件汇编', manual: '手动选择范围'}[p.assembly.mode];
    $('assembly-hint').textContent = scope.error ? scope.error : joint
      ? `勾选的 ${chosen.length} 个源码一起汇编，从入口开始执行；未勾选的不参与。`
      : p.assembly.mode === 'single' ? `只汇编 ${scope.entry}。`
      : `从 ${scope.entry} 的 main 开始${scope.files.length > 1 ? `，链接 ${scope.files.filter(n => n !== scope.entry).join('、')}` : ''}；其他文件不参与。`;
    $('entry-file').innerHTML = chosen.map(name => `<option value="${esc(name)}" ${name===scopeEntry ? 'selected' : ''}>${esc(name)}</option>`).join('') || '<option value="">先勾选源码</option>';
    $('entry-file').disabled = !chosen.length;
    $('export-file').disabled = !p.activeFile;
    $('restore-project').disabled = !previous && !hasBackup;
  }
  // One way in: the student picks or drags whatever they have and the IDE
  // works out what it is. Only a whole project raises a question; loose
  // files simply join the current one.
  function importDialog() {
    const folders = 'webkitdirectory' in $('folder-upload') && !/Android|iPhone|iPad/i.test(navigator.userAgent) && !(/Mac/.test(navigator.platform) && navigator.maxTouchPoints > 1);
    hooks.modal('导入', `<button id="choose-files" class="drop-zone"><b>把文件、文件夹或 ZIP 拖到这里，或点击选择</b><small>支持 .s / .asm、UTF-8 文本、ZIP 和 MARS 工程 JSON；最多 ${MAX_FILES} 个文件、${MAX_BYTES / 1_000_000} MB 文本。</small></button><p class="muted import-folder">${folders ? '<button id="choose-folder" class="link-button">选择文件夹…</button>' : '这个浏览器不能选择文件夹。请把文件夹压缩成 ZIP 再导入。'}</p>`);
    const zone = $('choose-files');
    zone.onclick = () => { $('upload').value=''; $('upload').click(); };
    if (folders) $('choose-folder').onclick = () => { $('folder-upload').value=''; $('folder-upload').click(); };
    zone.ondragover = () => zone.classList.add('over');
    zone.ondragleave = () => zone.classList.remove('over');
    zone.ondrop = async e => {
      zone.classList.remove('over');
      const list = [...e.dataTransfer.files], entries = [...e.dataTransfer.items].map(i => i.webkitGetAsEntry?.()).filter(Boolean);
      take(entries.length ? await droppedFiles(entries) : list);
    };
  }
  // A dropped folder arrives as a tree of entries, not as files.
  async function droppedFiles(entries, prefix = '') {
    const out = [];
    for (const entry of entries) {
      if (entry.isFile) {
        const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
        if (prefix) file.relativePath = prefix + file.name;
        out.push(file);
      } else {
        const reader = entry.createReader(), children = [];
        for (let batch; (batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject))).length;) children.push(...batch);
        out.push(...await droppedFiles(children, `${prefix}${entry.name}/`));
      }
    }
    return out;
  }
  async function receive(e) {
    const selected = [...e.target.files];
    e.target.value = '';
    if (selected.length) await take(selected);
  }
  async function take(selected) {
    try {
      const info = {}, incoming = await readImports(selected, info);
      if (info.kind) preview(incoming, info);
      else await add(incoming);
    } catch(error) { hooks.modal('导入未完成', `<p role="alert">${esc(error.message)}</p><p>当前工程未改变，请检查文件后重试。</p>`); }
  }
  async function add(incoming, folder = '') {
    const p = snapshot(), b = underFolder(incoming, folder), names = [...Object.keys(b.files), ...Object.keys(b.data)];
    const merge = overwrite => { const m = mergeProject(snapshot(), b, overwrite); return apply({...m, activeFile: m.activeFile || Object.keys(b.files)[0] || ''}); };
    const conflicts = names.filter(n => Object.hasOwn(p.files,n) || Object.hasOwn(p.data,n));
    if (conflicts.length) return confirm('存在同名文件', '以下文件会被覆盖：' + conflicts.join('、'), '覆盖同名并添加', () => merge(true));
    await merge(false);
    $('modal').close();
    hooks.notify(`已添加 ${names.length} 个文件。`, {transient: true});
  }
  function preview(incoming, {kind, skipped}) {
    const sources = Object.keys(incoming.files), inputs = Object.keys(incoming.data), row = (n, tag) => `<li><span>${esc(n)}</span><small>${tag}</small></li>`;
    hooks.modal('导入工程', `<p class="project-explanation"><b>${{zip: 'ZIP 工程包', json: 'MARS 工程', folder: '文件夹'}[kind]}</b>：${sources.length} 个源码、${inputs.length} 个输入文件${skipped.length ? `，跳过 ${skipped.length} 个` : ''}。</p><ul class="import-preview" aria-label="将导入的文件">${sources.map(n => row(n, '源码')).join('')}${inputs.map(n => row(n, '输入')).join('')}${skipped.map(n => `<li class="skipped"><span>${esc(n)}</span><small>跳过</small></li>`).join('')}</ul><fieldset class="import-target"><label><input type="radio" name="import-target" value="replace" checked> 作为新工程打开（替换当前内容）</label><label><input type="radio" name="import-target" value="add"> 添加到当前工程</label><label class="import-where">添加到 <select id="import-folder" disabled><option value="">根目录</option>${snapshot().folders.map(f => `<option value="${esc(f)}">${esc(f)}</option>`).join('')}</select></label></fieldset><p class="muted">当前工程会保留一份备份，可从“恢复上次管理操作”找回。</p><p id="project-error" role="alert"></p><div class="project-actions"><button id="project-cancel">取消</button><button id="project-confirm" class="primary">替换工程</button></div>`);
    const adding = () => document.querySelector('[name=import-target]:checked').value === 'add';
    document.querySelectorAll('[name=import-target]').forEach(r => r.onchange = () => { $('import-folder').disabled = !adding(); $('project-confirm').textContent = adding() ? '添加到工程' : '替换工程'; });
    $('project-cancel').onclick = () => $('modal').close();
    $('project-confirm').onclick = async e => {
      e.target.disabled = true;
      try {
        if (adding()) await add(incoming, $('import-folder').value);
        else { await apply(incoming); $('modal').close(); }
      } catch (error) { $('project-error').textContent = error.message; e.target.disabled = false; }
    };
  }
  $('new-project').onclick = () => confirm('新建空白工程', '清空当前工作区，创建一个不带演示代码的 main.s。', '新建工程', () => apply(blankProject()));
  $('project-title').onclick = () => form('工程名称', '名称', snapshot().name, value => { if (!value.trim()) throw Error('请输入名称。'); return apply({...snapshot(),name:value.trim()}); });
  $('new-file').onclick = () => create();
  $('new-folder').onclick = () => create('',true);
  $('import').onclick = importDialog;
  // A drop that misses the zone must not navigate away from the project.
  for (const type of ['dragover', 'drop']) document.addEventListener(type, e => { if (e.dataTransfer?.types.includes('Files')) e.preventDefault(); });
  $('upload').onchange = receive;
  $('folder-upload').onchange = receive;
  $('save-local').onclick = async () => { save(); await saving; hooks.notify(failed ? '浏览器存储不可用，请导出工程保存。' : '源码已保存到此浏览器；换设备前请导出工程。', {transient: true}); };
  $('save').onclick = () => {
    const p = snapshot();
    hooks.modal('导出工程', '<p>保存到电脑后可重新导入，或发给老师。源码、输入文件、目录、汇编方式和手动选择的范围都会保留。</p><div class="file-actions"><button id="download-zip">下载 ZIP（包含原始文件）</button><button id="download-json">下载 MARS 工程 JSON</button></div>');
    const basename = p.name.replace(/[\\/:*?"<>|]/g,'-') || 'mars-project';
    $('download-zip').onclick = () => { download(projectZip(p),basename+'.zip','application/zip'); $('modal').close(); };
    $('download-json').onclick = () => { download(JSON.stringify(p,null,2),basename+'.json','application/json'); $('modal').close(); };
  };
  $('export-file').onclick = () => downloadFile(hooks.snapshot().activeFile);
  $('entry-file').onchange = e => setAssembly({}, e.target.value);
  $('restore-project').onclick = async () => {
    try { const restore=previous || normalizeProject(await get(BACKUP_KEY)); confirm('恢复上次管理操作前的工程', `恢复“${restore.name}”的文件。当前内容会成为下一份备份。`, '恢复', () => apply(restore)); }
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
    assembly: () => meta.assembly,
    setAssembly,
    tabs: () => meta.openTabs.filter(n => Object.hasOwn(hooks.snapshot().files,n)),
    opened: name => { if (!meta.openTabs.includes(name)) meta.openTabs.push(name); changed(); },
    closeTab: name => { const active=hooks.snapshot().activeFile; meta.openTabs=meta.openTabs.filter(n=>n!==name); hooks.selectActive(active===name ? meta.openTabs.at(-1)||'' : active); render(); save(); },
    example: (p, name) => confirm('打开示例', '示例会替换当前工程。可以通过“恢复上次管理操作”找回当前内容。', '打开示例', async () => { await apply({...p,name}); await hooks.assemble(); }),
    async start() {
      let p;
      try {
        const saved = await get(DRAFT_KEY);
        if (saved) p=normalizeProject(saved);
      } catch { draftLocked=true; render(); hooks.selectActive(''); hooks.notify('之前的浏览器草稿无法读取，未覆盖旧草稿。可导入工程恢复，或新建工程重新开始。'); return; }
      hasBackup = await get(BACKUP_KEY).then(Boolean, () => false);
      await apply(p || blankProject(),false);
      hooks.notify(p ? '已恢复此浏览器中的工程；点击“汇编”开始执行。' : '空白工程已就绪：可直接写代码，或在“工程”菜单导入自己的文件。');
    },
  };
}
