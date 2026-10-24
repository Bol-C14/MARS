import { unzipSync, zipSync, strFromU8, strToU8 } from 'fflate';

export const MAX_BYTES = 1_500_000;
export const isSource = (name) => /\.(s|asm)$/.test(name);
export function pathName(value) {
  if (typeof value !== 'string') throw Error('文件路径必须是文字。');
  const name = value.trim().replaceAll('\\', '/');
  const parts = name.split('/');
  if (!name || name.startsWith('/') || /^[a-z]:/i.test(name) || /[\x00-\x1f\x7f]/.test(name) || parts.some(p => !p || p === '.' || p === '..' || ['__proto__', 'constructor', 'prototype'].includes(p)))
    throw Error('请使用工程内的相对路径，例如 src/main.s；路径不能含空层级、.. 或保留名称。');
  if (name.length > 240) throw Error('文件路径不能超过 240 个字符。');
  if (/(?:^|\/)\.mars-project\.json$/.test(name)) throw Error('.mars-project.json 是工程元数据保留名称。');
  return name;
}
export function normalizeProject(input) {
  if (!input || typeof input !== 'object' || !input.files || Array.isArray(input.files)) throw Error('不是有效的 MARS 工程文件。');
  const files = {}, data = {}, folders = new Set();
  let size = 0, count = 0;
  for (const [kind, target] of [['files', files], ['data', data]]) {
    const values = input[kind] || {};
    if (typeof values !== 'object' || Array.isArray(values)) throw Error('工程文件列表无效。');
    for (const [key, text] of Object.entries(values)) {
      const name = pathName(key);
      if (typeof text !== 'string') throw Error('目前只支持 UTF-8 文本文件。');
      if (kind === 'files' && !isSource(name)) throw Error(`源码文件 ${name} 需要使用小写 .s 或 .asm 扩展名。`);
      if (kind === 'data' && isSource(name)) throw Error(`${name} 应放在源码文件中。`);
      if (Object.hasOwn(files, name) || Object.hasOwn(data, name)) throw Error(`文件重复：${name}`);
      size += strToU8(text).length;
      if (++count > 200 || size > MAX_BYTES) throw Error('工程最多 200 个文件、1.5 MB 文本内容。');
      target[name] = text;
    }
  }
  if (input.folders != null && !Array.isArray(input.folders)) throw Error('文件夹列表无效。');
  for (const f of input.folders || []) folders.add(pathName(f));
  const names = [...Object.keys(files), ...Object.keys(data)];
  for (const name of [...names, ...folders]) {
    const parts = name.split('/');
    for (let i = 1; i < parts.length; i++) folders.add(parts.slice(0, i).join('/'));
  }
  if (folders.size > 200) throw Error('工程最多 200 个文件夹。');
  for (const name of names) if (folders.has(name)) throw Error(`${name} 不能同时作为文件和文件夹。`);
  const entry = Object.hasOwn(files, input.entry) ? input.entry : Object.hasOwn(files, 'main.s') ? 'main.s' : Object.keys(files)[0] || '';
  const activeFile = input.activeFile === '' ? '' : Object.hasOwn(files, input.activeFile) ? input.activeFile : entry;
  const openTabs = Array.isArray(input.openTabs) ? input.openTabs.filter((n, i, a) => Object.hasOwn(files, n) && a.indexOf(n) === i) : Object.keys(files);
  if (activeFile && !openTabs.includes(activeFile)) openTabs.push(activeFile);
  return {version: 2, name: String(input.name || '我的工程').slice(0, 80), files, data, folders: [...folders].sort(), entry, activeFile, openTabs, delay: Boolean(input.delay)};
}
export const blankProject = (name = '我的工程') => normalizeProject({name, files: {'main.s': '# 在这里编写 MIPS 汇编程序\n.text\n'}, data: {}, entry: 'main.s'});

export function renamePath(input, from, to) {
  const p = normalizeProject(input);
  from = pathName(from); to = pathName(to);
  if (from === to) return p;
  const folder = p.folders.includes(from);
  if (folder && to.startsWith(from + '/')) throw Error('不能把文件夹移动到它自己里面。');
  if (!folder && !Object.hasOwn(p.files, from) && !Object.hasOwn(p.data, from)) throw Error('文件不存在。');
  const match = n => n === from || (folder && n.startsWith(from + '/'));
  const move = n => match(n) ? to + n.slice(from.length) : n;
  const all = [...Object.keys(p.files), ...Object.keys(p.data), ...p.folders];
  for (const n of all.filter(match)) if (all.some(other => !match(other) && other === move(n))) throw Error(`目标已存在：${move(n)}`);
  if (!folder && isSource(from) !== isSource(to)) throw Error('重命名时请保持源码或输入文件的类型。');
  const remap = obj => Object.fromEntries(Object.entries(obj).map(([n, text]) => [move(n), text]));
  return normalizeProject({...p, files: remap(p.files), data: remap(p.data), folders: p.folders.map(move), entry: move(p.entry), activeFile: move(p.activeFile), openTabs: p.openTabs.map(move)});
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
  if (conflicts.length && !overwrite) throw Error('同名文件：' + conflicts.join('、'));
  return normalizeProject({...a, files: {...a.files, ...b.files}, data: {...a.data, ...b.data}, folders: [...a.folders, ...b.folders]});
}
export function projectZip(project) {
  const p = normalizeProject(project), entries = {};
  for (const [name, text] of Object.entries({...p.files, ...p.data})) entries[name] = strToU8(text);
  for (const f of p.folders) entries[f + '/'] = new Uint8Array();
  entries['.mars-project.json'] = strToU8(JSON.stringify({version: 2, name:p.name, entry:p.entry, folders:p.folders, delay:p.delay}, null, 2));
  return zipSync(entries, {level: 6});
}
function textFile(bytes, name) {
  try { return new TextDecoder('utf-8', {fatal: true}).decode(bytes); }
  catch { throw Error(`${name} 不是 UTF-8 文本，请先转换编码。`); }
}
const ignoredName = name => name.split('/').some(n => ['__MACOSX','.DS_Store','.git'].includes(n) || n.startsWith('._'));
export async function readImports(selected) {
  let files = {}, data = {}, folders = [], metadata = {}, seen = new Set(), total = 0;
  const add = (raw, bytes) => {
    if (ignoredName(raw)) return;
    const directory = raw.endsWith('/');
    const name = pathName(directory ? raw.slice(0, -1) : raw);
    if (directory) { folders.push(name); return; }
    if (seen.has(name)) throw Error(`导入中存在同名文件：${name}`);
    seen.add(name);
    total += bytes.length;
    if (total > MAX_BYTES || seen.size > 200) throw Error('导入最多 200 个文件、1.5 MB 解压后文本内容。');
    (isSource(name) ? files : data)[name] = textFile(bytes, name);
  };
  for (const f of selected) {
    const name = f.webkitRelativePath || f.name;
    if (ignoredName(name)) continue;
    if (f.size > 4_000_000) throw Error('单个导入文件不能超过 4 MB。');
    const bytes = new Uint8Array(await f.arrayBuffer());
    if (name.endsWith('/.mars-project.json')) {
      const m = JSON.parse(textFile(bytes,name)), prefix=name.slice(0,-'.mars-project.json'.length);
      if (m.folders != null && !Array.isArray(m.folders)) throw Error('文件夹工程信息无效。');
      metadata={...m,entry:m.entry ? prefix+m.entry : '',folders:(m.folders||[]).map(n=>prefix+n)};
      continue;
    }
    if (/\.zip$/i.test(f.name)) {
      let expanded = 0, entries = 0;
      const zipNames = new Set();
      const archive = unzipSync(bytes, {filter: e => {
        if (ignoredName(e.name)) return false;
        if (!e.name.endsWith('/') && zipNames.has(e.name)) throw Error('ZIP 内存在重复文件：' + e.name);
        zipNames.add(e.name);
        expanded += e.originalSize;
        if (expanded > MAX_BYTES + 16000 || ++entries > 410) throw Error('ZIP 超过解压大小或文件数量限制。');
        return true;
      }});
      if (archive['.mars-project.json']) {
        metadata = JSON.parse(textFile(archive['.mars-project.json'], '.mars-project.json'));
        if (metadata.folders != null && !Array.isArray(metadata.folders)) throw Error('ZIP 文件夹信息无效。');
        delete archive['.mars-project.json'];
      }
      for (const [n, value] of Object.entries(archive)) add(n, value);
    } else if (selected.length === 1 && /\.json$/i.test(f.name)) {
      let parsed;
      try { parsed = JSON.parse(textFile(bytes, name)); } catch {}
      if (parsed?.files) return normalizeProject(parsed);
      add(name, bytes);
    } else add(name, bytes);
  }
  if (!seen.size && !folders.length) throw Error('没有可导入的文件。');
  return normalizeProject({...metadata, files, data, folders: [...folders, ...(metadata.folders || [])]});
}
