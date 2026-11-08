import { t } from "./i18n/index.js";
import {escapeHTML as esc} from './model.js';
import {blankProject, normalizeProject, pathName, isSource, renamePath, removePath, mergeProject, underFolder, readImports, projectZip, assemblyScope, MAX_BYTES, MAX_FILES} from './workspace.js';
import {put, get} from './store.js';

export const DRAFT_KEY = 'mars-trace:project:v2';
const BACKUP_KEY = 'mars-trace:previous-project:v2';
const $ = id => document.getElementById(id);
// File tree icons (classroom 2026-11-03): a folder, MIPS source, C source and
// headers, plain text, and a blank page for any other kind of file. C files
// open as ordinary text; only .s / .asm are assembled.
const PAGE = '<path class="page" d="M3.5 1.5h6l3 3v10h-9z"/><path class="page" d="M9.5 1.5v3h3"/>';
const badge = (letter) => `<text x="8" y="12.3" text-anchor="middle">${letter}</text>`;
export function fileKind(path) {
  if (isSource(path)) return 'asm';
  if (/\.c$/i.test(path)) return 'c';
  if (/\.h$/i.test(path)) return 'h';
  if (/\.txt$/i.test(path)) return 'text';
  return 'other';
}
const ICONS = {
  asm: PAGE + badge('S'),
  c: PAGE + badge('C'),
  h: PAGE + badge('H'),
  text: PAGE + '<path class="line" d="M5.5 8h5M5.5 10.5h5M5.5 13h3"/>',
  other: PAGE,
  folder: '<path class="shape" d="M1.5 4a1 1 0 0 1 1-1h3.5l1.5 1.5h6a1 1 0 0 1 1 1V12.5a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1z"/>',
  open: '<path class="shape" d="M1.5 4a1 1 0 0 1 1-1h3.5l1.5 1.5h5.5a1 1 0 0 1 1 1V7"/><path class="shape" d="M1.5 12.5 3.3 7.6a1 1 0 0 1 .9-.6h10.3l-2 6.5H2.5a1 1 0 0 1-1-1z"/>',
};
const icon = (kind) => `<svg class="file-icon ${kind}" viewBox="0 0 16 16" aria-hidden="true">${ICONS[kind]}</svg>`;
export function projectManager(hooks) {
  let meta = blankProject(), timer, failed = false, replacing = false, draftLocked = false, previous = null, hasBackup = false, saving = Promise.resolve();
  const snapshot = () => normalizeProject({...meta, ...hooks.snapshot()});
  const message = text => { $('workspace-status').textContent = text; };
  function save() {
    clearTimeout(timer);
    if (draftLocked) { message(t("project.status.unreadable")); return false; }
    const done = ok => { failed = !ok; message(ok ? t("project.status.saved") : t("project.status.failed")); };
    try { saving = put(DRAFT_KEY, snapshot()).then(() => done(true), () => done(false)); }
    catch { done(false); }
    return !failed;
  }
  function changed() {
    if (replacing) return;
    message(t("project.status.saving"));
    clearTimeout(timer);
    timer = setTimeout(save, 350);
  }
  async function apply(input, backup = true) {
    if (hooks.busy()) throw Error(t("project.busy"));
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
    if (hooks.busy()) { hooks.notify(t("project.busyScope")); render(); return; }
    const current = hooks.sourceFile?.() || hooks.snapshot().activeFile, assembly = {...meta.assembly, ...patch};
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
    hooks.modal(title, `<form id="project-form"><label>${esc(label)}<input id="project-value" value="${esc(value)}" required autocomplete="off"></label>${hint ? `<p class="muted">${esc(hint)}</p>` : ''}<p id="project-error" role="alert"></p><div class="project-actions"><button type="button" id="project-cancel">${t("common.cancel")}</button><button class="primary">${t("common.ok")}</button></div></form>`);
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
    hooks.modal(title, `<p class="project-explanation">${esc(explanation)}</p><p class="muted">${t("project.backupNote")}</p><p id="project-error" role="alert"></p><div class="project-actions"><button id="project-cancel">${t("common.cancel")}</button><button class="primary" id="project-confirm">${esc(label)}</button></div>`);
    $('project-cancel').onclick = () => $('modal').close();
    $('project-confirm').onclick = async e => {
      e.target.disabled = true;
      try { await action(); $('modal').close(); }
      catch (error) { $('project-error').textContent = error.message; e.target.disabled = false; }
    };
  }
  function create(folder = '', directory = false) {
    const prefix = folder ? folder + '/' : '';
    form(directory ? t("files.newFolder") : t("files.newFile"), t("files.path"), prefix + (directory ? t("files.newFolder.default") : 'new.s'), async value => {
      const name = pathName(value), p = snapshot();
      if (Object.hasOwn(p.files,name) || Object.hasOwn(p.data,name) || p.folders.includes(name)) throw Error(t("files.exists"));
      if (directory) p.folders.push(name);
      else if (isSource(name)) { p.files[name] = ''; p.activeFile = name; p.openTabs.push(name); if (!p.entry) p.entry = name; }
      else { p.data[name] = ''; p.activeFile = name; p.openTabs.push(name); }
      await apply(p);
      if (!directory && !isSource(name)) setTimeout(() => hooks.editData(name));
    }, directory ? t("files.newFolder.hint") : t("files.newFile.hint"));
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
    hooks.modal(folder ? t("files.node.folder", { path }) : t("files.node.file", { path }), `<div class="file-actions">${folder ? `<button id="node-new-file">${t("files.newFile")}</button><button id="node-new-folder">${t("files.newSubfolder")}</button>` : `<button id="node-download">${t("files.download")}</button>`}${isSource(path) && !folder && p.assembly.mode==='manual' ? `<button id="node-entry" ${p.entry===path && p.assembly.files.includes(path) ? 'disabled' : ''}>${p.entry===path && p.assembly.files.includes(path) ? t("files.isEntry") : t("files.setEntry")}</button>` : ''}<button id="node-rename">${t("files.rename")}</button><button class="danger" id="node-delete">${folder ? t("files.deleteFolder") : t("files.delete")}</button></div><p class="muted">${t("files.rename.hint")}</p>`);
    if (folder) {
      $('node-new-file').onclick = () => create(path);
      $('node-new-folder').onclick = () => create(path, true);
    } else $('node-download').onclick = () => downloadFile(path);
    if ($('node-entry')) $('node-entry').onclick = () => { setAssembly({files:[...new Set([...meta.assembly.files,path])]}, path); $('modal').close(); };
    $('node-rename').onclick = () => form(t("files.rename"), t("files.newPath"), path, value => apply(renamePath(snapshot(), path, value)));
    $('node-delete').onclick = () => {
      const count = [...Object.keys(p.files),...Object.keys(p.data)].filter(n => n === path || n.startsWith(path+'/')).length;
      confirm(t("files.confirmDelete"), t("files.confirmDelete.text", { path, contents: folder ? ` ${t("files.confirmDelete.contents", { count })}` : '' }), t("common.delete"), () => apply(removePath(snapshot(), path)));
    };
  }
  const collapsed = new Set();
  function render() {
    const p = snapshot();
    $('project-title').textContent = p.name;
    $('project-title').title = t("project.rename.title");
    // A manual scope shows a checkbox per source and the entry among them;
    // auto and single assembly need neither.
    const joint = p.assembly.mode === 'manual', chosen = p.assembly.files;
    const scopeEntry = chosen.includes(p.entry) ? p.entry : chosen.includes('main.s') ? 'main.s' : chosen[0];
    const rows = parent => {
      const base = parent ? parent + '/' : '';
      const immediate = name => name.startsWith(base) && !name.slice(base.length).includes('/');
      const directories = p.folders.filter(immediate);
      const paths = [...Object.keys(p.files),...Object.keys(p.data)].filter(immediate).sort();
      return directories.map(path => `<li><details data-folder="${esc(path)}" ${collapsed.has(path) ? '' : 'open'}><summary>${icon('folder')}${icon('open')}<span class="folder-name">${esc(path.slice(base.length))}</span><button class="tree-menu" data-node="${esc(path)}" data-directory="true" title="${t("files.manageFolder")}" aria-label="${t("files.manageFolder.label", { path: esc(path) })}">⋯</button></summary><ul>${rows(path) || `<li class="tree-empty">${t("files.emptyFolder")}</li>`}</ul></details></li>`).join('') + paths.map(path => `<li class="tree-row ${path===p.activeFile ? 'active' : ''} ${hooks.hasError(path) ? 'has-error' : ''} ${joint && chosen.includes(path) ? 'joined' : ''}">${joint && isSource(path) ? `<input type="checkbox" class="joint-pick" data-joint="${esc(path)}" ${chosen.includes(path) ? 'checked' : ''} aria-label="${t("files.joint.label", { path: esc(path) })}" title="${t("files.joint")}">` : ''}<button class="tree-open" ${isSource(path) ? 'data-file' : 'data-data'}="${esc(path)}" title="${esc(path)}">${icon(fileKind(path))}<span class="tree-name">${esc(path.slice(base.length))}</span>${joint && path===scopeEntry ? `<small class="entry-badge" title="${t("assembly.entry")}" aria-label="${t("assembly.entry")}"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 8h8M7 4.5 10.5 8 7 11.5"/><path d="M13.5 3v10"/></svg></small>` : ''}</button><button class="tree-menu" data-node="${esc(path)}" title="${t("files.manageFile")}" aria-label="${t("files.manageFile.label", { path: esc(path) })}">⋯</button></li>`).join('');
    };
    $('files').innerHTML = `<ul class="file-tree" aria-label="${t("files.tree")}">${rows('') || `<li class="tree-empty">${t("files.empty")}</li>`}</ul>`;
    $('files').querySelectorAll('[data-file]').forEach(b => b.onclick = () => hooks.openFile(b.dataset.file));
    $('files').querySelectorAll('[data-data]').forEach(b => b.onclick = () => hooks.editData(b.dataset.data));
    $('files').querySelectorAll('[data-node]').forEach(b => b.onclick = e => { e.preventDefault(); e.stopPropagation(); menu(b.dataset.node, b.dataset.directory==='true'); });
    $('files').querySelectorAll('details').forEach(d => d.ontoggle = () => { if (d.open) collapsed.delete(d.dataset.folder); else collapsed.add(d.dataset.folder); });
    $('files').querySelectorAll('[data-joint]').forEach(c => c.onchange = () => setAssembly({files: c.checked ? [...chosen, c.dataset.joint] : chosen.filter(n => n !== c.dataset.joint)}));
    $('joint-settings').hidden = !joint;
    const scope = assemblyScope(p, hooks.sourceFile?.() || p.activeFile);
    $('assembly-mode-name').textContent = {auto: t("assembly.mode.auto"), single: t("assembly.mode.single"), manual: t("assembly.mode.manualName")}[p.assembly.mode];
    $('assembly-hint').textContent = scope.error ? scope.error : joint
      ? t("assembly.hint.manual", { count: chosen.length })
      : p.assembly.mode === 'single' ? t("assembly.hint.single", { entry: scope.entry })
      : t("assembly.hint.auto", { entry: scope.entry, linked: scope.files.length > 1 ? t("assembly.hint.linked", { files: scope.files.filter(n => n !== scope.entry).join(t("common.listSep")) }) : '' });
    $('entry-file').innerHTML = chosen.map(name => `<option value="${esc(name)}" ${name===scopeEntry ? 'selected' : ''}>${esc(name)}</option>`).join('') || `<option value="">${t("assembly.hint.tick")}</option>`;
    $('entry-file').disabled = !chosen.length;
    $('export-file').disabled = !p.activeFile;
    $('restore-project').disabled = !previous && !hasBackup;
  }
  // One way in: the student picks or drags whatever they have and the IDE
  // works out what it is. Only a whole project raises a question; loose
  // files simply join the current one.
  function importDialog() {
    const folders = 'webkitdirectory' in $('folder-upload') && !/Android|iPhone|iPad/i.test(navigator.userAgent) && !(/Mac/.test(navigator.platform) && navigator.maxTouchPoints > 1);
    hooks.modal(t("import.title"), `<button id="choose-files" class="drop-zone"><b>${t("import.drop")}</b><small>${t("import.supported", { files: MAX_FILES, mb: MAX_BYTES / 1_000_000 })}</small></button><p class="muted import-folder">${folders ? `<button id="choose-folder" class="link-button">${t("import.chooseFolder")}</button>` : t("import.noFolder")}</p>`);
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
    } catch(error) { hooks.modal(t("import.failed"), `<p role="alert">${esc(error.message)}</p><p>${t("import.failed.note")}</p>`); }
  }
  async function add(incoming, folder = '') {
    const p = snapshot(), b = underFolder(incoming, folder), names = [...Object.keys(b.files), ...Object.keys(b.data)];
    const merge = overwrite => { const m = mergeProject(snapshot(), b, overwrite); return apply({...m, activeFile: m.activeFile || Object.keys(b.files)[0] || ''}); };
    const conflicts = names.filter(n => Object.hasOwn(p.files,n) || Object.hasOwn(p.data,n));
    if (conflicts.length) return confirm(t("import.conflict"), t("import.conflict.note", { files: conflicts.join(t("common.listSep")) }), t("import.conflict.overwrite"), () => merge(true));
    await merge(false);
    $('modal').close();
    hooks.notify(t("import.added", { count: names.length }), {transient: true});
  }
  function preview(incoming, {kind, skipped}) {
    const sources = Object.keys(incoming.files), inputs = Object.keys(incoming.data), row = (n, tag) => `<li><span>${esc(n)}</span><small>${tag}</small></li>`;
    hooks.modal(t("import.project"), `<p class="project-explanation"><b>${{zip: t("import.kind.zip"), json: t("import.kind.json"), folder: t("import.kind.folder")}[kind]}</b>${t("import.preview.summary", { sources: sources.length, inputs: inputs.length, skipped: skipped.length ? t("import.preview.skipped", { count: skipped.length }) : '' })}</p><ul class="import-preview" aria-label="${t("import.preview.files")}">${sources.map(n => row(n, t("import.preview.source"))).join('')}${inputs.map(n => row(n, t("import.preview.input"))).join('')}${skipped.map(n => `<li class="skipped"><span>${esc(n)}</span><small>${t("import.preview.skip")}</small></li>`).join('')}</ul><fieldset class="import-target"><label><input type="radio" name="import-target" value="replace" checked> ${t("import.asNew")}</label><label><input type="radio" name="import-target" value="add"> ${t("import.addToCurrent")}</label><label class="import-where">${t("import.addInto")} <select id="import-folder" disabled><option value="">${t("import.root")}</option>${snapshot().folders.map(f => `<option value="${esc(f)}">${esc(f)}</option>`).join('')}</select></label></fieldset><p class="muted">${t("import.backupNote")}</p><p id="project-error" role="alert"></p><div class="project-actions"><button id="project-cancel">${t("common.cancel")}</button><button id="project-confirm" class="primary">${t("import.replace")}</button></div>`);
    const adding = () => document.querySelector('[name=import-target]:checked').value === 'add';
    document.querySelectorAll('[name=import-target]').forEach(r => r.onchange = () => { $('import-folder').disabled = !adding(); $('project-confirm').textContent = adding() ? t("import.add") : t("import.replace"); });
    $('project-cancel').onclick = () => $('modal').close();
    $('project-confirm').onclick = async e => {
      e.target.disabled = true;
      try {
        if (adding()) await add(incoming, $('import-folder').value);
        else { await apply(incoming); $('modal').close(); }
      } catch (error) { $('project-error').textContent = error.message; e.target.disabled = false; }
    };
  }
  $('new-project').onclick = () => confirm(t("commands.newProject"), t("project.new.note"), t("menu.project.new"), () => apply(blankProject()));
  $('project-title').onclick = () => form(t("project.name"), t("project.name.label"), snapshot().name, value => { if (!value.trim()) throw Error(t("project.name.required")); return apply({...snapshot(),name:value.trim()}); });
  $('new-file').onclick = () => create();
  $('new-folder').onclick = () => create('',true);
  $('import').onclick = importDialog;
  // A drop that misses the zone must not navigate away from the project.
  for (const type of ['dragover', 'drop']) document.addEventListener(type, e => { if (e.dataTransfer?.types.includes('Files')) e.preventDefault(); });
  $('upload').onchange = receive;
  $('folder-upload').onchange = receive;
  $('save-local').onclick = async () => { save(); await saving; hooks.notify(failed ? t("project.saveUnavailable") : t("project.savedNote"), {transient: true}); };
  $('save').onclick = () => {
    const p = snapshot();
    hooks.modal(t("export.title"), `<p>${t("export.note")}</p><div class="file-actions"><button id="download-zip">${t("export.zip")}</button><button id="download-json">${t("export.json")}</button></div>`);
    const basename = p.name.replace(/[\\/:*?"<>|]/g,'-') || 'mars-project';
    $('download-zip').onclick = () => { download(projectZip(p),basename+'.zip','application/zip'); $('modal').close(); };
    $('download-json').onclick = () => { download(JSON.stringify(p,null,2),basename+'.json','application/json'); $('modal').close(); };
  };
  $('export-file').onclick = () => downloadFile(hooks.snapshot().activeFile);
  $('entry-file').onchange = e => setAssembly({}, e.target.value);
  $('restore-project').onclick = async () => {
    try { const restore=previous || normalizeProject(await get(BACKUP_KEY)); confirm(t("restore.title"), t("restore.note", { name: restore.name }), t("restore.button"), () => apply(restore)); }
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
    tabs: () => { const p=hooks.snapshot(); return [...meta.openTabs.filter(n => Object.hasOwn(p.files,n) || Object.hasOwn(p.data,n))]; },
    opened: name => { if (!meta.openTabs.includes(name)) meta.openTabs.push(name); changed(); },
    closeTab: name => { const active=hooks.snapshot().activeFile; meta.openTabs=meta.openTabs.filter(n=>n!==name); const remaining=meta.openTabs; hooks.selectActive(active===name ? remaining.at(-1)||'' : active); render(); save(); },
    example: (p, name) => confirm(t("examples.open"), t("examples.open.note"), t("examples.open"), async () => { await apply({...p,name}); await hooks.assemble(); }),
    async start() {
      let p;
      try {
        const saved = await get(DRAFT_KEY);
        if (saved) p=normalizeProject(saved);
      } catch { draftLocked=true; render(); hooks.selectActive(''); hooks.notify(t("project.draftUnreadable")); return; }
      hasBackup = await get(BACKUP_KEY).then(Boolean, () => false);
      await apply(p || blankProject(),false);
      hooks.notify(p ? t("project.restored") : t("project.blankReady"));
      return Boolean(p);
    },
  };
}
