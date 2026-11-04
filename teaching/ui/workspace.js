import { t } from "./i18n/index.js";
import { unzipSync, zipSync, strFromU8, strToU8 } from 'fflate';

export const MAX_BYTES = 4_000_000, MAX_FILES = 500;
const LIMIT = () => t("workspace.limit", { files: MAX_FILES, mb: MAX_BYTES / 1_000_000 });
export const isSource = (name) => /\.(s|asm)$/.test(name);
export function pathName(value) {
  if (typeof value !== 'string') throw Error(t("workspace.path.notText"));
  const name = value.trim().replaceAll('\\', '/');
  const parts = name.split('/');
  if (!name || name.startsWith('/') || /^[a-z]:/i.test(name) || /[\x00-\x1f\x7f]/.test(name) || parts.some(p => !p || p === '.' || p === '..' || ['__proto__', 'constructor', 'prototype'].includes(p)))
    throw Error(t("workspace.path.invalid"));
  if (name.length > 240) throw Error(t("workspace.path.tooLong"));
  if (/(?:^|\/)\.mars-project\.json$/.test(name)) throw Error(t("workspace.path.reserved"));
  return name;
}
export function normalizeProject(input) {
  if (!input || typeof input !== 'object' || !input.files || Array.isArray(input.files)) throw Error(t("workspace.notProject"));
  const files = {}, data = {}, folders = new Set();
  let size = 0, count = 0;
  for (const [kind, target] of [['files', files], ['data', data]]) {
    const values = input[kind] || {};
    if (typeof values !== 'object' || Array.isArray(values)) throw Error(t("workspace.badFiles"));
    for (const [key, text] of Object.entries(values)) {
      const name = pathName(key);
      if (typeof text !== 'string') throw Error(t("workspace.textOnly"));
      if (kind === 'files' && !isSource(name)) throw Error(t("workspace.sourceExtension", { name }));
      if (kind === 'data' && isSource(name)) throw Error(t("workspace.belongsInSource", { name }));
      if (Object.hasOwn(files, name) || Object.hasOwn(data, name)) throw Error(t("workspace.duplicate", { name }));
      size += strToU8(text).length;
      if (++count > MAX_FILES || size > MAX_BYTES) throw Error(t("workspace.tooLarge", { limit: LIMIT() }));
      target[name] = text;
    }
  }
  if (input.folders != null && !Array.isArray(input.folders)) throw Error(t("workspace.badFolders"));
  for (const f of input.folders || []) folders.add(pathName(f));
  const names = [...Object.keys(files), ...Object.keys(data)];
  for (const name of [...names, ...folders]) {
    const parts = name.split('/');
    for (let i = 1; i < parts.length; i++) folders.add(parts.slice(0, i).join('/'));
  }
  if (folders.size > MAX_FILES) throw Error(t("workspace.tooManyFolders", { max: MAX_FILES }));
  for (const name of names) if (folders.has(name)) throw Error(t("workspace.fileAndFolder", { name }));
  const entry = Object.hasOwn(files, input.entry) ? input.entry : Object.hasOwn(files, 'main.s') ? 'main.s' : Object.keys(files)[0] || '';
  const activeFile = input.activeFile === '' ? '' : (Object.hasOwn(files, input.activeFile) || Object.hasOwn(data, input.activeFile)) ? input.activeFile : entry;
  const openTabs = Array.isArray(input.openTabs) ? input.openTabs.filter((n, i, a) => (Object.hasOwn(files, n) || Object.hasOwn(data, n)) && a.indexOf(n) === i) : [];
  if (activeFile && !openTabs.includes(activeFile)) openTabs.push(activeFile);
  return {version: 3, name: String(input.name || t("project.defaultName")).slice(0, 80), files, data, folders: [...folders].sort(), entry, activeFile, openTabs, delay: Boolean(input.delay), assembly: normalizeAssembly(input.assembly, files)};
}
// Assembly scope (P0, 2026-10-24 classroom). Three ways, chosen beside the
// assemble button and saved with the project:
// - auto (default): start from main and link the files it needs, so
//   independent exercises that each define main can sit in one project;
// - single: only the file being edited;
// - manual: exactly the checked files, with the top-level `entry`.
// Projects saved before this field open in auto. The first P0 draft's names
// (current, joint) still read as single and manual.
const MODES = {auto: 'auto', single: 'single', manual: 'manual', current: 'single', joint: 'manual'};
function normalizeAssembly(input, files) {
  const chosen = Array.isArray(input?.files) ? input.files.filter((n, i, a) => typeof n === 'string' && Object.hasOwn(files, n) && a.indexOf(n) === i) : [];
  return {mode: MODES[input?.mode] || 'auto', files: chosen};
}
const dirOf = name => name.includes('/') ? name.slice(0, name.lastIndexOf('/')) : '';
// What an assembly request would contain right now: the files and the entry.
// `error` explains why nothing can be assembled.
export function assemblyScope(p, activeFile) {
  const mode = p.assembly?.mode || 'auto';
  if (mode === 'manual') {
    const files = p.assembly.files.filter(n => Object.hasOwn(p.files, n));
    if (!files.length) return {mode, files, entry: '', error: t("scope.manualEmpty")};
    return {mode, files, entry: files.includes(p.entry) ? p.entry : files.includes('main.s') ? 'main.s' : files[0]};
  }
  if (!activeFile || !Object.hasOwn(p.files, activeFile)) return {mode, files: [], entry: '', error: t("scope.openSource")};
  if (mode === 'single') return {mode, files: [activeFile], entry: activeFile};
  return autoScope(p.files, activeFile);
}
// The scope is worked out on every keystroke; only the edited file changes.
const scans = new Map();
function scanned(name, text) {
  let scan = scans.get(name);
  if (scan?.text !== text) scans.set(name, scan = {text, ...labelsIn(text), refs: referencesIn(text)});
  return scan;
}
// Auto: the open file is the program when it defines main. Otherwise the
// one file in its folder that defines main is, and the open file joins it;
// with no main anywhere the open file runs from its first instruction. Then
// every global label the program uses is linked from the file that defines
// it, preferring the entry's folder. Files with their own main are other
// programs and are never linked, so the open file is the only main source.
function autoScope(sources, activeFile) {
  const info = new Map(Object.entries(sources).map(([n, t]) => [n, scanned(n, t)]));
  const hasMain = n => info.get(n).defined.has('main');
  const fail = error => ({mode: 'auto', files: [], entry: '', error});
  let entry = activeFile;
  if (!hasMain(activeFile)) {
    const mains = Object.keys(sources).filter(n => n !== activeFile && dirOf(n) === dirOf(activeFile) && hasMain(n));
    if (mains.length > 1) return fail(t("scope.manyMains", { file: activeFile, mains: mains.join(t("common.listSep")) }));
    if (mains.length) entry = mains[0];
  }
  const files = entry === activeFile ? [entry] : [entry, activeFile];
  const provides = (n, sym) => info.get(n).globals.has(sym) && info.get(n).defined.has(sym);
  for (let i = 0; i < files.length; i++) {
    const own = info.get(files[i]);
    for (const sym of own.refs) {
      if (own.defined.has(sym) || files.some(n => provides(n, sym))) continue;
      const providers = Object.keys(sources).filter(n => !files.includes(n) && !hasMain(n) && provides(n, sym));
      const near = providers.filter(n => dirOf(n) === dirOf(entry)), pick = near.length ? near : providers;
      if (pick.length > 1) return fail(t("scope.ambiguousSymbol", { file: files[i], sym, files: pick.join(t("common.listSep")) }));
      if (pick.length) files.push(pick[0]);
    }
  }
  return {mode: 'auto', files, entry};
}
export const blankProject = (name = t("project.defaultName")) => normalizeProject({name, files: {'main.s': `${t("workspace.newSource")}
`}, data: {}, entry: 'main.s'});

export function renamePath(input, from, to) {
  const p = normalizeProject(input);
  from = pathName(from); to = pathName(to);
  if (from === to) return p;
  const folder = p.folders.includes(from);
  if (folder && to.startsWith(from + '/')) throw Error(t("workspace.moveIntoItself"));
  if (!folder && !Object.hasOwn(p.files, from) && !Object.hasOwn(p.data, from)) throw Error(t("workspace.missing"));
  const match = n => n === from || (folder && n.startsWith(from + '/'));
  const move = n => match(n) ? to + n.slice(from.length) : n;
  const all = [...Object.keys(p.files), ...Object.keys(p.data), ...p.folders];
  for (const n of all.filter(match)) if (all.some(other => !match(other) && other === move(n))) throw Error(t("workspace.targetExists", { path: move(n) }));
  if (!folder && isSource(from) !== isSource(to)) throw Error(t("workspace.keepKind"));
  const remap = obj => Object.fromEntries(Object.entries(obj).map(([n, text]) => [move(n), text]));
  return normalizeProject({...p, files: remap(p.files), data: remap(p.data), folders: p.folders.map(move), entry: move(p.entry), activeFile: move(p.activeFile), openTabs: p.openTabs.map(move), assembly: {...p.assembly, files: p.assembly.files.map(move)}});
}
export function removePath(input, path) {
  const p = normalizeProject(input);
  const matches = n => n === path || n.startsWith(path + '/');
  const keep = obj => Object.fromEntries(Object.entries(obj).filter(([n]) => !matches(n)));
  return normalizeProject({...p, files: keep(p.files), data: keep(p.data), folders: p.folders.filter(n => !matches(n))});
}
export function mergeProject(current, incoming, overwrite = false) {
  const a = normalizeProject(current), b = normalizeProject(incoming);
  const names = new Set([...Object.keys(a.files), ...Object.keys(a.data)]);
  const conflicts = [...Object.keys(b.files), ...Object.keys(b.data)].filter(n => names.has(n));
  if (conflicts.length && !overwrite) throw Error(t("workspace.sameName", { files: conflicts.join(t("common.listSep")) }));
  // Added files never join the current joint-assembly selection by themselves.
  return normalizeProject({...a, files: {...a.files, ...b.files}, data: {...a.data, ...b.data}, folders: [...a.folders, ...b.folders]});
}
// The same project, placed inside a folder of the one it joins.
export function underFolder(input, folder) {
  const p = normalizeProject(input);
  if (!folder) return p;
  const remap = obj => Object.fromEntries(Object.entries(obj).map(([n, text]) => [`${folder}/${n}`, text]));
  return normalizeProject({...p, files: remap(p.files), data: remap(p.data), folders: [folder, ...p.folders.map(n => `${folder}/${n}`)], entry: '', activeFile: '', openTabs: []});
}
export function projectZip(project) {
  const p = normalizeProject(project), entries = {};
  for (const [name, text] of Object.entries({...p.files, ...p.data})) entries[name] = strToU8(text);
  for (const f of p.folders) entries[f + '/'] = new Uint8Array();
  entries['.mars-project.json'] = strToU8(JSON.stringify({version: 3, name:p.name, entry:p.entry, folders:p.folders, delay:p.delay, assembly:p.assembly, activeFile:p.activeFile, openTabs:p.openTabs}, null, 2));
  return zipSync(entries, {level: 6});
}
function textFile(bytes, name) {
  try { return new TextDecoder('utf-8', {fatal: true}).decode(bytes); }
  catch { throw Error(t("workspace.notUtf8", { name })); }
}
const ignoredName = name => name.split('/').some(n => ['__MACOSX','.DS_Store','.git'].includes(n) || n.startsWith('._'));
// `info` reports what was read: kind (zip, json or folder, unset for loose
// files) and skipped. A folder or ZIP usually holds handouts next to the code,
// so what cannot be read is listed there instead of stopping the import.
export async function readImports(selected, info = {}) {
  info.skipped = [];
  let files = {}, data = {}, folders = [], metadata = {}, seen = new Set(), total = 0;
  const add = (raw, bytes, lenient = false) => {
    if (ignoredName(raw)) return;
    const directory = raw.endsWith('/');
    const name = pathName(directory ? raw.slice(0, -1) : raw);
    if (directory) { folders.push(name); return; }
    if (seen.has(name)) throw Error(t("workspace.import.duplicate", { name }));
    let text;
    try { text = textFile(bytes, name); }
    catch (error) { if (!lenient) throw error; info.skipped.push(t("workspace.import.skipNotText", { name })); return; }
    seen.add(name);
    total += bytes.length;
    if (total > MAX_BYTES || seen.size > MAX_FILES) throw Error(t("workspace.import.tooLarge", { limit: LIMIT() }));
    (isSource(name) ? files : data)[name] = text;
  };
  for (const f of selected) {
    const name = f.relativePath || f.webkitRelativePath || f.name, inFolder = name !== f.name;
    if (ignoredName(name)) continue;
    if (inFolder) info.kind = 'folder';
    if (f.size > 2 * MAX_BYTES) {
      if (!inFolder) throw Error(t("workspace.import.fileTooLarge", { mb: 2 * MAX_BYTES / 1_000_000 }));
      info.skipped.push(t("workspace.import.skipTooLarge", { name }));
      continue;
    }
    const bytes = new Uint8Array(await f.arrayBuffer());
    if (name.endsWith('/.mars-project.json')) {
      const m = JSON.parse(textFile(bytes,name)), prefix=name.slice(0,-'.mars-project.json'.length);
      if (m.folders != null && !Array.isArray(m.folders)) throw Error(t("workspace.import.badFolderMeta"));
      metadata={...m,entry:m.entry ? prefix+m.entry : '',folders:(m.folders||[]).map(n=>prefix+n),assembly:m.assembly && {...m.assembly,files:Array.isArray(m.assembly.files) ? m.assembly.files.map(n=>prefix+n) : []}};
      continue;
    }
    if (/\.zip$/i.test(f.name)) {
      info.kind = 'zip';
      let expanded = 0, entries = 0;
      const zipNames = new Set();
      const archive = unzipSync(bytes, {filter: e => {
        if (ignoredName(e.name)) return false;
        if (!e.name.endsWith('/') && zipNames.has(e.name)) throw Error(t("workspace.import.zipDuplicate", { name: e.name }));
        zipNames.add(e.name);
        expanded += e.originalSize;
        if (expanded > MAX_BYTES + 16000 || ++entries > 2 * MAX_FILES + 10) throw Error(t("workspace.import.zipTooLarge"));
        return true;
      }});
      if (archive['.mars-project.json']) {
        metadata = JSON.parse(textFile(archive['.mars-project.json'], '.mars-project.json'));
        if (metadata.folders != null && !Array.isArray(metadata.folders)) throw Error(t("workspace.import.zipBadFolders"));
        delete archive['.mars-project.json'];
      }
      for (const [n, value] of Object.entries(archive)) add(n, value, true);
    } else if (selected.length === 1 && /\.json$/i.test(f.name)) {
      let parsed;
      try { parsed = JSON.parse(textFile(bytes, name)); } catch {}
      if (parsed?.files) { info.kind = 'json'; return normalizeProject(parsed); }
      add(name, bytes);
    } else add(name, bytes, inFolder);
  }
  if (!seen.size && !folders.length) throw Error(t("workspace.import.nothing"));
  return normalizeProject({...metadata, files, data, folders: [...folders, ...(metadata.folders || [])]});
}

const stripped = raw => raw.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, '""').replace(/#.*/, '');
const labelPrefix = /^\s*([A-Za-z_.$][\w.$]*)\s*:/;
// Labels a source defines and declares global, read from its text only (no
// assembling): enough to link files and to say which files a diagnostic is
// about.
export function labelsIn(text) {
  const defined = new Set(), globals = new Set();
  for (const raw of String(text).split('\n')) {
    let line = stripped(raw);
    for (let m; (m = labelPrefix.exec(line)); line = line.slice(m[0].length)) defined.add(m[1]);
    const g = /^\s*\.globl\s+(.+)/.exec(line);
    if (g) for (const name of g[1].split(/[\s,]+/).filter(Boolean)) globals.add(name);
  }
  return {defined, globals};
}
// Names a source uses as operands of instructions and data words (jal
// helper, la $a0, prompt, .word table): candidates for labels in other files.
export function referencesIn(text) {
  const refs = new Set();
  for (const raw of String(text).split('\n')) {
    let line = stripped(raw);
    for (let m; (m = labelPrefix.exec(line)); line = line.slice(m[0].length));
    const [, op = '', operands = ''] = /^\s*(\S+)\s*(.*)$/.exec(line) || [];
    if (op.startsWith('.') && !/^\.(word|half|byte)$/.test(op)) continue;
    for (const m of operands.matchAll(/(?<![\w$.%])[A-Za-z_][\w.$]*/g)) refs.add(m[0]);
  }
  return refs;
}
// One plain explanation per assembler diagnostic that is about the assembly
// scope: a global defined by two assembled files, or a label that lives in a
// project file outside this assembly. Other diagnostics get ''.
export function scopeHints(diagnostics, project, scope) {
  const labels = new Map(Object.entries(project.files).map(([n, t]) => [n, labelsIn(t)]));
  const list = names => names.join(t("common.listSep"));
  return (diagnostics || []).map(d => {
    let m = /^"(.+)" already defined as global in a different file/.exec(d.message || '');
    if (m) {
      const owners = scope.files.filter(n => labels.get(n)?.globals.has(m[1]) && labels.get(n).defined.has(m[1]));
      return t("diag.duplicateGlobal", { files: list(owners.length > 1 ? owners : scope.files), label: m[1] }) + (scope.mode === 'manual'
        ? t("diag.duplicateGlobal.manual")
        : t("diag.duplicateGlobal.other"));
    }
    m = /^Symbol "(.+)" not found in symbol table/.exec(d.message || '');
    if (m) {
      const sym = m[1], owners = [...labels].filter(([n, l]) => !scope.files.includes(n) && l.defined.has(sym)).map(([n]) => n);
      if (!owners.length) return '';
      const local = owners.filter(n => !labels.get(n).globals.has(sym));
      if (local.length === owners.length) return t("diag.notGlobal", { sym, files: list(owners), sym });
      if (scope.mode === 'manual') return t("diag.notTicked", { sym, files: list(owners) });
      if (scope.mode === 'single') return t("diag.singleFile", { sym, files: list(owners) });
      return t("diag.otherProgram", { sym, files: list(owners) });
    }
    return '';
  });
}
