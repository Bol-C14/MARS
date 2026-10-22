import {
  EditorView,
  Decoration,
  ViewPlugin,
  GutterMarker,
  gutter,
  keymap,
} from "@codemirror/view";
import { EditorState, StateEffect } from "@codemirror/state";
import { basicSetup } from "codemirror";
import { autocompletion } from "@codemirror/autocomplete";
import {
  hex,
  escapeHTML as esc,
  registerNames,
  canonicalReg,
  services,
  explanations,
  role,
  references,
  buildCFG,
} from "./model.js";
import { ActionPlayer } from "./actions.js";
import { OverlayRenderer } from "./overlay.js";
const $ = (id) => document.getElementById(id);
let state = null,
  files = {},
  data = {},
  activeFile = "",
  view = "source",
  bottom = "console",
  dirty = false,
  busy = false,
  running = false,
  focus = null,
  pinned = new Set(["$v0", "$sp", "$ra"]),
  breakpoints = [],
  watches = [],
  exampleList = [],
  fontSize = 13;
let inspecting = null,
  program = { instructions: [], symbols: [], instructionDocs: {} },
  fileStates = new Map(),
  loadEditor = false;
const refresh = StateEffect.define();
class Dot extends GutterMarker {
  constructor(active) {
    super();
    this.active = active;
  }
  toDOM() {
    let e = document.createElement("span");
    e.className = "break-dot";
    e.textContent = this.active ? "●" : "·";
    return e;
  }
}
function lineAddress(line) {
  return program.instructions.find(
    (i) => i.file === activeFile && i.line === line,
  )?.address;
}
const decorations = ViewPlugin.fromClass(
  class {
    constructor(v) {
      this.decorations = this.build(v);
    }
    update(u) {
      if (u.docChanged || u.viewportChanged || u.transactions.length)
        this.decorations = this.build(u.view);
    }
    build(v) {
      let ranges = [];
      for (let { from, to } of v.visibleRanges) {
        for (let pos = from; pos <= to;) {
          let l = v.state.doc.lineAt(pos);
          let cls = [];
          if (
            !dirty &&
            state?.last?.instruction?.file === activeFile &&
            state.last.instruction.line === l.number
          )
            cls.push("last-line");
          if (
            !dirty &&
            state?.preview?.instruction?.file === activeFile &&
            state.preview.instruction.line === l.number
          )
            cls.push("next-line");
          if (cls.length)
            ranges.push(
              Decoration.line({ class: cls.join(" ") }).range(l.from),
            );
          let text = l.text,
            comment = text.indexOf("#"),
            code = comment < 0 ? text : text.slice(0, comment);
          for (let m of code.matchAll(
            /\$\w+|\b0x[\da-fA-F]+\b|\b\d+\b|\b[a-zA-Z_]\w*:?/g,
          )) {
            let type = m[0].startsWith("$")
              ? "reg"
              : m[0].endsWith(":")
                ? "label"
                : /^\d/.test(m[0])
                  ? "number"
                  : program.instructionDocs[m[0]] || explanations[m[0]]
                    ? "op"
                    : null;
            if (type)
              ranges.push(
                Decoration.mark({ class: "cm-" + type }).range(
                  l.from + m.index,
                  l.from + m.index + m[0].length,
                ),
              );
          }
          if (comment >= 0)
            ranges.push(
              Decoration.mark({ class: "cm-comment" }).range(
                l.from + comment,
                l.to,
              ),
            );
          pos = l.to + 1;
        }
      }
      return Decoration.set(ranges, true);
    }
  },
  { decorations: (v) => v.decorations },
);
const breakpointGutter = gutter({
  class: "breakpoints-gutter",
  lineMarker: (v, line) =>
    new Dot(
      breakpoints.some(
        (b) =>
          b.file === activeFile &&
          b.line === v.state.doc.lineAt(line.from).number,
      ),
    ),
  initialSpacer: () => new Dot(false),
  lineMarkerChange: () => true,
  domEventHandlers: {
    mousedown: (v, line, event) => {
      toggleBreakpoint(v.state.doc.lineAt(line.from).number, event.altKey);
      return true;
    },
  },
});
function completion(context) {
  let word = context.matchBefore(/[\w.$]*/);
  if (!word || (word.from === word.to && !context.explicit)) return null;
  return {
    from: word.from,
    options: [
      ...registerNames.map((n) => ({
        label: "$" + n,
        type: "variable",
        detail: role("$" + n),
      })),
      ...Object.entries(program.instructionDocs).map(([label, d]) => ({
        label,
        type: "keyword",
        detail: d.description,
      })),
      ...program.symbols.map((s) => ({
        label: s.name,
        type: "constant",
        detail: hex(s.address),
      })),
    ],
  };
}
const editor = new EditorView({
  state: EditorState.create({
    doc: "",
    extensions: [
      basicSetup,
      decorations,
      breakpointGutter,
      autocompletion({ override: [completion] }),
      keymap.of([
        {
          key: "F12",
          run: () => {
            inspectToken(tokenAt(editor.state.selection.main.head));
            return true;
          },
        },
      ]),
      EditorView.updateListener.of((u) => {
        if (u.docChanged && !loadEditor) {
          files[activeFile] = u.state.doc.toString();
          dirty = true;
          player.update(null);
          renderTabs();
          updateControls();
          $("banner").textContent =
            "源码已修改 · 重新汇编后继续执行；旧轨迹属于上一版本";
          $("banner").className = "visible";
        }
        overlay?.schedule();
      }),
      EditorView.domEventHandlers({
        mousemove: (e) => hover(e),
        mouseleave: () => {
          $("tooltip").hidden = true;
        },
        click: (e) => {
          if (e.metaKey || e.ctrlKey) {
            let pos = editor.posAtCoords({ x: e.clientX, y: e.clientY });
            if (pos != null) inspectToken(tokenAt(pos));
          }
        },
      }),
    ],
  }),
  parent: $("editor"),
});
const player = new ActionPlayer({
  onChange: () => overlay.schedule(),
  onObject: (a) =>
    a.kind === "memory" ? memoryAt(a.address) : inspectToken(a.name),
});
const overlay = new OverlayRenderer({
  getAction: () => player.selection(),
  getState: () => (dirty ? null : state ? { ...state, ...program } : null),
  getEditor: () => editor,
  getFile: () => activeFile,
  getView: () => view,
  getFocus: () => focus,
  onAddress: (a) => memoryAt(a),
  onSource: (a) => gotoAddress(a),
});
function tokenAt(pos) {
  let l = editor.state.doc.lineAt(pos),
    col = pos - l.from;
  let address = [
    ...l.text.matchAll(/(?:-?(?:0x[\da-fA-F]+|\d+))?\(\$\w+\)/g),
  ].find((m) => col >= m.index && col <= m.index + m[0].length);
  if (address) return address[0];
  let words = [...l.text.matchAll(/\$\w+|[\w.]+/g)];
  return (
    words.find((m) => col >= m.index && col <= m.index + m[0].length)?.[0] || ""
  );
}
function regValue(name) {
  return (
    state?.registers.find((r) => r.name === canonicalReg(name))?.value ?? 0
  );
}
function valueHTML(n) {
  let v = n | 0,
    c = v & 255;
  return `<div class="values"><span>hex</span><span>${hex(v)}</span><span>signed</span><span>${v}</span><span>unsigned</span><span>${v >>> 0}</span><span>bits</span><span class="bits">${(v >>> 0).toString(2).padStart(32, "0").match(/.{4}/g).join(" ")}</span><span>ASCII低字节</span><span>${c >= 32 && c < 127 ? esc(String.fromCharCode(c)) : c === 0 ? "NUL" : "不可打印"} (${c})</span></div>`;
}
function summary(token) {
  token = canonicalReg(token);
  if (token.startsWith("$"))
    return `<b>${esc(token)}</b> ${hex(regValue(token))}<p>${esc(role(token))}</p><small>当前快照 S${state?.step ?? 0} · Cmd/Ctrl＋点击固定</small>`;
  if (token === "syscall") {
    let n = regValue("$v0"),
      s = services[n];
    return `<b>syscall ${n} · ${s?.[0] || "未支持服务"}</b><p>参数 ${s?.[1].join(", ") || "无"}；结果 ${s?.[2].join(", ") || "无"}</p>`;
  }
  if (explanations[token] || program.instructionDocs[token])
    return `<b>${esc(token)}</b><p>${esc(explanations[token] || program.instructionDocs[token].description)}</p><small>指令／汇编器说明</small>`;
  let symbol = program.symbols.find((s) => s.name === token);
  if (symbol)
    return `<b>${esc(token)}</b><p>符号地址 ${hex(symbol.address)}</p><small>Cmd/Ctrl＋点击跳转定义</small>`;
  return `<b>${esc(token)}</b><p>点击查询地址或源码引用</p>`;
}
function hover(e) {
  let pos = editor.posAtCoords({ x: e.clientX, y: e.clientY }),
    token = pos == null ? "" : tokenAt(pos);
  if (!token) {
    $("tooltip").hidden = true;
    return;
  }
  $("tooltip").innerHTML = summary(token);
  $("tooltip").hidden = false;
  $("tooltip").style.left = Math.min(e.clientX + 12, innerWidth - 380) + "px";
  $("tooltip").style.top = Math.min(e.clientY + 18, innerHeight - 180) + "px";
}
function showContext(html) {
  $("context").innerHTML = html;
}
function inspectToken(token) {
  if (!token) return;
  inspecting = token;
  $("tooltip").hidden = true;
  let address = token.match(/^(-?(?:0x[\da-fA-F]+|\d+))?\((\$\w+)\)$/);
  if (address) {
    let base = regValue(address[2]),
      offset = Number(address[1] || 0),
      effective = (base + offset) | 0;
    showContext(
      `<h3>${esc(token)}</h3><p>当前快照中的有效地址</p><div class="values"><span>基址</span><span>${esc(address[2])} = ${hex(base)}</span><span>偏移</span><span>${offset} 字节</span><span>地址</span><span>${hex(effective)}</span></div><button id="inspect-memory">查看内存 →</button>`,
    );
    $("inspect-memory").onclick = () => memoryAt(effective);
    return;
  }
  token = canonicalReg(token);
  if (token.startsWith("$") || token === "hi" || token === "lo") {
    focus = token;
    pinned.add(token);
    let value = regValue(token),
      last = state?.lastWriters?.[token];
    showContext(
      `<h3>${esc(token)} <small class="muted">寄存器</small></h3><p>${esc(role(token))}</p>${valueHTML(value)}<p class="muted">当前快照 S${state?.step ?? 0} · 最后写入 ${last ? "#" + last : "初始状态"}</p><div class="context-actions"><button id="refs">查找引用</button><button id="pin">${pinned.has(token) ? "取消固定" : "固定"}</button><button id="point">作为地址查看</button><button id="last-write" ${last ? "" : "disabled"}>最后写入</button><button id="next-write">运行到下次写入</button></div>`,
    );
    $("refs").onclick = () => showReferences(token);
    $("pin").onclick = () => {
      pinned.has(token) ? pinned.delete(token) : pinned.add(token);
      renderRegisters();
    };
    $("point").onclick = () => memoryAt(value);
    $("last-write").onclick = () => command("seek", { step: last });
    $("next-write").onclick = () => runUntilWrite(token);
    renderRegisters();
    overlay.schedule();
    return;
  }
  if (token === "syscall") {
    let n = regValue("$v0"),
      s = services[n];
    showContext(
      `<h3>syscall ${n} · ${s?.[0] || "未支持"}</h3><p>MARS 服务约定 · 当前快照</p>${(s?.[1] || []).map((r) => `<p><code>${r}</code> = ${hex(regValue(r))}</p>`).join("")}<p>结果：${s?.[2].join(", ") || "无返回值"}</p><p class="muted">服务编号与返回值可能复用 $v0。输入预览停在“等待输入”，不会消费输入。</p><button id="service-list">查看服务表</button>`,
    );
    $("service-list").onclick = () =>
      modal(
        "MARS 服务",
        Object.entries(services)
          .map(
            ([id, s]) =>
              `<p><b>${id}</b> ${s[0]} · ${s[1].join(", ") || "—"} → ${s[2].join(", ") || "—"}</p>`,
          )
          .join(""),
      );
    return;
  }
  let symbol = program.symbols.find((s) => s.name === token);
  if (symbol) {
    showContext(
      `<h3>${esc(token)}</h3><p>符号地址 <code>${hex(symbol.address)}</code></p><div class="context-actions"><button id="definition">定义</button><button id="symbol-memory">查看内存</button><button id="refs">引用</button></div>`,
    );
    $("definition").onclick = () => gotoSymbol(symbol);
    $("symbol-memory").onclick = () => memoryAt(symbol.address);
    $("refs").onclick = () => showReferences(token);
    gotoSymbol(symbol);
    return;
  }
  showContext(
    `<h3>${esc(token)}</h3><p>${esc(explanations[token] || program.instructionDocs[token]?.description || "当前工程中的文本／立即数")}</p><p class="muted">${esc(program.instructionDocs[token]?.example || "")}</p><div class="context-actions"><button id="refs">查找引用</button></div>`,
  );
  $("refs").onclick = () => showReferences(token);
}
function showReferences(token) {
  let refs = references(files, token);
  modal(
    "引用 · " + token,
    refs.length
      ? refs
          .map(
            (r, i) =>
              `<button class="command-item" data-ref="${i}"><b>${esc(r.file)}:${r.line}</b> <small>${r.type}</small><p class="mono">${esc(r.text)}</p></button>`,
          )
          .join("")
      : "无静态引用。",
  );
  document.querySelectorAll("[data-ref]").forEach(
    (b) =>
      (b.onclick = () => {
        let r = refs[Number(b.dataset.ref)];
        $("modal").close();
        gotoSource(r.file, r.line);
      }),
  );
}
function modal(title, html) {
  $("modal-content").innerHTML = `<h3>${esc(title)}</h3>${html}`;
  if (!$("modal").open) $("modal").showModal();
}
function notify(message) {
  $("banner").textContent = message;
  $("banner").className = message ? "visible" : "";
}
async function api(body) {
  let r = await fetch("/api", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    s = await r.json();
  if (!r.ok || !s.protocol) throw Error(s.error || "执行服务未返回状态");
  return s;
}
async function command(name, extra = {}) {
  if (busy) return null;
  player.stop();
  busy = true;
  updateControls();
  try {
    let s = await api({
      command: name,
      programVersion: state?.programVersion,
      ...extra,
    });
    state = s;
    render();
    player.update(dirty ? null : state, {
      autoplay: !running && ["step", "source", "over", "out"].includes(name),
    });
    return s;
  } catch (e) {
    notify(e.message);
    running = false;
    return null;
  } finally {
    busy = false;
    updateControls();
  }
}
async function assemble() {
  if (busy) return;
  running = false;
  busy = true;
  updateControls();
  try {
    let old = state?.programVersion;
    savedEditor();
    state = await api({
      command: "assemble",
      files,
      data,
      entry: files["main.s"] ? "main.s" : Object.keys(files)[0],
      delay: $("delay").checked,
    });
    program = {
      instructions: state.instructions || [],
      symbols: state.symbols || [],
      instructionDocs: state.instructionDocs || {},
    };
    dirty = false;
    breakpoints = breakpoints
      .map((b) => ({
        ...b,
        address: program.instructions.find(
          (i) => i.file === b.file && i.line === b.line,
        )?.address,
      }))
      .filter((b) => b.address != null);
    notify(state.error || "");
    render();
    followPC();
  } catch (e) {
    notify(e.message);
  } finally {
    busy = false;
    updateControls();
  }
}
function savedEditor() {
  if (activeFile) files[activeFile] = editor.state.doc.toString();
}
function switchFile(file) {
  if (!files.hasOwnProperty(file)) return;
  savedEditor();
  if (activeFile) fileStates.set(activeFile, editor.state.selection);
  activeFile = file;
  loadEditor = true;
  editor.dispatch({
    changes: { from: 0, to: editor.state.doc.length, insert: files[file] },
    selection: fileStates.get(file) || { anchor: 0 },
  });
  loadEditor = false;
  renderTabs();
  renderFiles();
  overlay.schedule();
}
function gotoSource(file, line) {
  if (!files.hasOwnProperty(file)) return;
  if (file !== activeFile) switchFile(file);
  setView("source");
  let l = editor.state.doc.line(
    Math.min(Math.max(1, line), editor.state.doc.lines),
  );
  editor.dispatch({
    selection: { anchor: l.from },
    effects: EditorView.scrollIntoView(l.from, { y: "center" }),
  });
  editor.focus();
}
function gotoAddress(address) {
  let ins = program.instructions.find((i) => i.address === address);
  if (ins) gotoSource(ins.file, ins.line);
}
function gotoSymbol(s) {
  for (let [file, src] of Object.entries(files)) {
    if (s.file && s.file !== file) continue;
    let index = src
      .split("\n")
      .findIndex((l) => l.trimStart().startsWith(s.name + ":"));
    if (index >= 0) {
      gotoSource(file, index + 1);
      return;
    }
  }
  gotoAddress(s.address);
}
function followPC() {
  let ins = program.instructions.find((i) => i.address === state?.pc);
  if (ins && view === "source") gotoSource(ins.file, ins.line);
  if (view === "machine")
    document
      .querySelector(`[data-instruction="${state.pc}"]`)
      ?.scrollIntoView({ block: "nearest" });
}
function setView(v) {
  view = v;
  $("editor").hidden = v !== "source";
  $("editor").style.display = v === "source" ? "" : "none";
  $("machine").hidden = v !== "machine";
  $("cfg").hidden = v !== "cfg";
  document
    .querySelectorAll("[data-view]")
    .forEach((b) => b.classList.toggle("selected", b.dataset.view === v));
  if (v === "machine") renderMachine();
  if (v === "cfg") renderCFG();
  overlay.schedule();
}
function setBottom(v) {
  bottom = v;
  for (let name of ["console", "trace", "calls", "problems"])
    $(name).hidden = name !== v;
  document
    .querySelectorAll("[data-bottom]")
    .forEach((b) => b.classList.toggle("selected", b.dataset.bottom === v));
}
function updateControls() {
  for (let name of ["step", "source", "over", "out", "run"])
    $(name).disabled =
      busy || dirty || !state || !["paused", "waiting"].includes(state.status);
  $("back").disabled = busy || dirty || !state?.step;
  $("assemble").disabled = busy;
  $("pause").disabled = !running;
  $("status").textContent = dirty
    ? "源码已修改"
    : {
        empty: "未汇编",
        paused: "暂停",
        waiting: "等待输入",
        ended: "执行结束",
        error: "错误",
      }[state?.status] || "未汇编";
}
function renderFiles() {
  $("files").innerHTML = Object.keys(files)
    .map(
      (f) =>
        `<button class="file ${f === activeFile ? "active" : ""}" data-file="${esc(f)}">◇ ${esc(f)}</button>`,
    )
    .join("");
  $("files")
    .querySelectorAll("[data-file]")
    .forEach((b) => (b.onclick = () => switchFile(b.dataset.file)));
  $("data-files").innerHTML =
    Object.keys(data)
      .map(
        (f) =>
          `<button class="file" data-data="${esc(f)}">▤ ${esc(f)}<small>${new TextEncoder().encode(data[f]).length} bytes</small></button>`,
      )
      .join("") + '<button class="file" id="add-data">＋ 添加输入文件</button>';
  $("data-files")
    .querySelectorAll("[data-data]")
    .forEach((b) => (b.onclick = () => editData(b.dataset.data)));
  $("add-data").onclick = () =>
    ask("输入文件名", "input.txt", (name) => {
      if (name) {
        data[name] = "";
        editData(name);
      }
    });
}
function renderTabs() {
  $("tabs").innerHTML = Object.keys(files)
    .map(
      (f) =>
        `<button class="${f === activeFile ? "active" : ""}" data-tab="${esc(f)}">${esc(f)}${dirty ? " •" : ""}</button>`,
    )
    .join("");
  $("tabs")
    .querySelectorAll("button")
    .forEach((b) => (b.onclick = () => switchFile(b.dataset.tab)));
}
function renderSymbols() {
  let q = $("symbol-search").value.toLowerCase();
  $("symbols").innerHTML = program.symbols
    .filter(
      (s) => s.name.toLowerCase().includes(q) || hex(s.address).includes(q),
    )
    .map(
      (s, i) =>
        `<button class="symbol" data-symbol="${esc(s.name)}">${esc(s.name)}<small>${hex(s.address)}</small></button>`,
    )
    .join("");
  $("symbols")
    .querySelectorAll("button")
    .forEach((b) => (b.onclick = () => inspectToken(b.dataset.symbol)));
}
function accesses() {
  return state?.last?.accesses || state?.preview?.accesses || [];
}
function renderRegisters() {
  if (!state) return;
  let all = accesses(),
    related = new Set(
      all.filter((a) => a.kind === "register").map((a) => a.name),
    );
  let filter = $("reg-filter").value;
  $("registers").innerHTML = state.registers
    .filter((r) =>
      filter === "all" || filter === "pinned"
        ? filter === "all" || pinned.has(r.name)
        : related.has(r.name) || pinned.has(r.name),
    )
    .map(
      (r) =>
        `<div tabindex="0" class="reg ${all.some((a) => a.name === r.name && !a.write) ? "read" : ""} ${all.some((a) => a.name === r.name && a.write) ? "write" : ""} ${pinned.has(r.name) ? "pinned" : ""} ${focus === r.name ? "focus" : ""}" data-register="${r.name}" title="${r.name}: ${r.value} · 点击查看"><span class="name">${r.name}</span><span>${hex(r.value).slice(2)}</span></div>`,
    )
    .join("");
  $("registers")
    .querySelectorAll(".reg")
    .forEach((e) => {
      e.onclick = () => inspectToken(e.dataset.register);
      e.onkeydown = (k) => {
        if (k.key === "Enter") e.click();
      };
    });
}
function renderMemory() {
  if (!state) return;
  $("address").value = hex(state.memoryBase);
  let all = accesses().filter((a) => a.kind === "memory");
  let rows = [];
  for (let i = 0; i < state.memory.length; i += 8) {
    let bytes = state.memory.slice(i, i + 8);
    rows.push(
      `<div class="mem-row"><span class="mem-address">${hex(bytes[0].address).slice(2)}</span>${bytes.map((b) => `<span tabindex="0" class="byte ${all.some((a) => !a.write && b.address >= a.address && b.address < a.address + a.width) ? "read" : ""} ${all.some((a) => a.write && b.address >= a.address && b.address < a.address + a.width) ? "write" : ""} ${focus === "mem:" + b.address ? "focus" : ""}" data-byte="${b.address}" title="${hex(b.address)}">${b.value == null ? "??" : b.value.toString(16).padStart(2, "0")}</span>`).join("")}<span class="ascii">${bytes.map((b) => (b.value >= 32 && b.value < 127 ? esc(String.fromCharCode(b.value)) : ".")).join("")}</span></div>`,
    );
  }
  $("memory").innerHTML = rows.join("");
  $("memory")
    .querySelectorAll("[data-byte]")
    .forEach((e) => {
      e.onclick = () => inspectByte(Number(e.dataset.byte));
      e.onkeydown = (k) => {
        if (k.key === "Enter") e.click();
      };
    });
}
function inspectByte(address) {
  focus = "mem:" + address;
  let value = state.memory.find((b) => b.address === address)?.value,
    last = state.lastWriters["mem:" + address];
  inspecting = null;
  showContext(
    `<h3>内存 ${hex(address)}</h3><p>地址对应的内容 · 1 字节</p>${value == null ? "<p>不可访问</p>" : valueHTML(value)}<button id="watch-memory">在此地址设置写入观察点</button><button id="memory-last-write" ${last ? "" : "disabled"}>最后写入 ${last ? "#" + last : ""}</button>`,
  );
  $("memory-last-write").onclick = () => command("seek", { step: last });
  $("watch-memory").onclick = () => {
    watches.push({ address, access: "write" });
    renderStops();
  };
  renderMemory();
  overlay.schedule();
}
async function memoryAt(address) {
  await command("memory", { address: address | 0 });
  overlay.schedule();
}
function renderCards() {
  player.update(dirty ? null : state);
  let last = state?.last,
    next = state?.preview;
  $("last-card").innerHTML =
    `<small>刚完成 ${last ? "#" + last.step : ""} · 实线</small><b>${esc(last?.instruction?.basic || "尚无执行记录")}</b>`;
  $("next-card").innerHTML =
    `<small>即将执行 ${next?.instruction ? "#" + next.step : ""} · 虚线 ${next?.status === "waiting-input" ? "· 等待输入" : ""}</small><b>${esc(next?.instruction?.basic || "—")}</b>`;
  for (let [id, e] of [
    ["last-card", last],
    ["next-card", next],
  ]) {
    $(id).title = e?.instruction
      ? `${e.instruction.file}:${e.instruction.line} · ${hex(e.pc)}`
      : "";
    $(id).onclick = () => {
      if (e?.instruction) {
        gotoSource(e.instruction.file, e.instruction.line);
        inspectToken(e.instruction.op);
      }
    };
  }
}
function renderMachine() {
  $("machine").innerHTML = program.instructions
    .map(
      (i) =>
        `<div class="instruction ${i.address === state?.pc ? "next" : ""} ${i.address === state?.last?.pc ? "last" : ""}" data-instruction="${i.address}"><span data-machine-bp="${i.address}">${breakpoints.some((b) => b.address === i.address) ? "●" : "·"}</span><span>${hex(i.address).slice(2)}</span><span>${esc(i.basic)}</span><small>${esc(i.file)}:${i.line} · ${hex(i.binary)} · ${esc(i.source?.trim())}</small></div>`,
    )
    .join("");
  $("machine")
    .querySelectorAll("[data-instruction]")
    .forEach(
      (e) =>
        (e.onclick = (event) => {
          let address = Number(e.dataset.instruction);
          if (event.target.dataset.machineBp) {
            toggleAddressBreakpoint(address, event.altKey);
            return;
          }
          let ins = program.instructions.find((i) => i.address === address);
          inspectToken(ins.op);
        }),
    );
}
function renderCFG() {
  let blocks = buildCFG(program.instructions, state?.delay);
  $("cfg").innerHTML =
    `<p class="muted">静态基本块 · 间接目标运行时确定 · 紫色边显示去向；计数来自本次轨迹</p>` +
    blocks
      .map((b) => {
        let loop = (state?.loops || []).find((l) => l.header === b.start);
        let count =
          Object.entries(state?.edges || {})
            .filter(([k]) => Number(k.split(":")[1]) === b.start)
            .reduce((n, [, v]) => n + v, 0) +
          (b.start === program.instructions[0]?.address && state?.step > 0
            ? 1
            : 0);
        return `<article class="block ${b.instructions.some((i) => i.address === state?.pc) ? "current" : ""}" id="block-${b.id}"><div class="block-title"><button data-jump="${b.start}">${hex(b.start)} · ${esc(program.symbols.find((s) => s.address === b.start)?.name || "block")}</button><span>进入 ${count} 次${loop ? ` · 回跳 ${loop.backJumps} 次` : ""}</span></div>${b.instructions.map((i) => `<code>${esc(i.basic)}</code>`).join("")}<div class="edges">${b.edges.map((e) => `<button data-block-target="${e.target ?? ""}">${e.label} → ${e.target == null ? "未知" : hex(e.target)}</button>`).join("")}</div></article>`;
      })
      .join("");
  $("cfg")
    .querySelectorAll("[data-jump]")
    .forEach((b) => (b.onclick = () => gotoAddress(Number(b.dataset.jump))));
  $("cfg")
    .querySelectorAll("[data-block-target]")
    .forEach(
      (b) =>
        (b.onclick = () => {
          if (b.dataset.blockTarget)
            document
              .getElementById("block-" + b.dataset.blockTarget)
              ?.scrollIntoView({ block: "center" });
        }),
    );
}
function renderTrace() {
  let trace = state?.trace || [],
    groups = [],
    group = null;
  for (let e of trace) {
    let key = e.instruction?.file + ":" + e.instruction?.line;
    if (group && group.key === key) group.events.push(e);
    else {
      group = { key, events: [e] };
      groups.push(group);
    }
  }
  const row = (e) =>
    `<button class="trace-row ${e.step === state.step ? "selected" : ""}" data-seek="${e.step}"><span>#${e.step}</span><span>${esc(e.instruction?.basic)}</span><small>${esc(e.instruction?.file)}:${e.instruction?.line}${e.output ? " · 输出" : ""}</small></button>`;
  $("trace").innerHTML =
    `<div><input id="seek-number" type="number" min="0" max="${state?.historyLength || 0}" value="${state?.step || 0}" aria-label="历史步骤"><button id="seek-go">转到步骤</button><span class="muted">显示附近 170 步；可跳转全部历史</span></div>` +
    (state?.loops || [])
      .filter((loop) => loop.entries > 0)
      .map(
        (loop) =>
          `<details class="loop-history"><summary>循环 ${hex(loop.header)} · 进入 ${loop.entries} 次 · 回跳 ${loop.backJumps} 次</summary>${loop.iterations
            .slice(-200)
            .map(
              (step, index) =>
                `<button class="trace-row" data-seek="${step - 1}">第 ${Math.max(0, loop.iterations.length - 200) + index + 1} 次 · 从 #${step} 开始</button>`,
            )
            .join("")}</details>`,
      )
      .join("") +
    groups
      .map((g) =>
        g.events.length > 1
          ? `<details><summary>${esc(g.key)} · ${g.events.length} 条实际指令</summary>${g.events.map(row).join("")}</details>`
          : row(g.events[0]),
      )
      .join("");
  $("trace")
    .querySelectorAll("[data-seek]")
    .forEach(
      (b) =>
        (b.onclick = () => command("seek", { step: Number(b.dataset.seek) })),
    );
  $("seek-go").onclick = () =>
    command("seek", { step: Number($("seek-number").value) });
}
function render() {
  if (!state) return;
  renderFiles();
  renderTabs();
  renderSymbols();
  renderRegisters();
  renderMemory();
  renderCards();
  renderTrace();
  renderStops();
  $("output").textContent = state.output;
  $("output").scrollTop = $("output").scrollHeight;
  $("pc").textContent = "PC " + hex(state.pc);
  $("location").textContent = `S${state.step} · ${hex(state.pc)}`;
  $("history-info").textContent = `${state.step} / ${state.historyLength} 步`;
  $("calls").innerHTML =
    state.calls
      .map(
        (c) =>
          `<button class="trace-row" data-call="${c.step}">#${c.step} ${esc(c.instruction.basic)} → 返回 ${hex(c.return)}</button>`,
      )
      .join("") +
    '<p class="muted">按 jal / jalr / jr $ra 跟踪的调用约定视图。</p>';
  $("calls")
    .querySelectorAll("[data-call]")
    .forEach(
      (b) =>
        (b.onclick = () => command("seek", { step: Number(b.dataset.call) })),
    );
  $("problems").innerHTML =
    state.diagnostics
      .map(
        (d, i) =>
          `<button class="command-item" data-diagnostic="${i}">${esc(d.file)}:${d.line} · ${esc(d.message)}</button>`,
      )
      .join("") + (state.error ? `<pre>${esc(state.error)}</pre>` : "");
  $("problems")
    .querySelectorAll("[data-diagnostic]")
    .forEach(
      (b) =>
        (b.onclick = () => {
          let d = state.diagnostics[Number(b.dataset.diagnostic)];
          gotoSource(d.file, d.line);
        }),
    );
  if (state.error) {
    notify(state.error);
    setBottom("problems");
  } else if (!dirty)
    notify(state.stopReason === "Batch complete" ? "" : state.stopReason);
  editor.dispatch({ effects: refresh.of(null) });
  if (view === "machine") renderMachine();
  if (view === "cfg") renderCFG();
  if (inspecting?.startsWith("$")) inspectToken(inspecting);
  overlay.schedule();
  updateControls();
}
function toggleAddressBreakpoint(address, conditional = false) {
  let ins = program.instructions.find((i) => i.address === address);
  if (!ins) return;
  let i = breakpoints.findIndex((b) => b.address === address);
  if (i >= 0 && !conditional) breakpoints.splice(i, 1);
  else if (conditional)
    ask("断点条件，例如 $t0 == 3", "", (condition) => {
      breakpoints = breakpoints.filter((b) => b.address !== address);
      breakpoints.push({ address, file: ins.file, line: ins.line, condition });
      renderStops();
      editor.dispatch({ effects: refresh.of(null) });
    });
  else
    breakpoints.push({
      address,
      file: ins.file,
      line: ins.line,
      condition: "",
    });
  renderStops();
  editor.dispatch({ effects: refresh.of(null) });
  if (view === "machine") renderMachine();
}
function toggleBreakpoint(line, conditional = false) {
  let address = lineAddress(line);
  if (address == null) {
    notify("此行没有已汇编指令。先汇编，或在实际指令视图设置断点。");
    return;
  }
  toggleAddressBreakpoint(address, conditional);
}
function renderStops() {
  $("breakpoints").innerHTML = breakpoints
    .map(
      (b, i) =>
        `<button class="bp" data-bp="${i}">● ${esc(b.file)}:${b.line}<br>${hex(b.address)} ${esc(b.condition)}</button>`,
    )
    .join("");
  $("breakpoints")
    .querySelectorAll("[data-bp]")
    .forEach(
      (b) =>
        (b.onclick = (e) => {
          let index = Number(b.dataset.bp);
          if (e.altKey) {
            breakpoints.splice(index, 1);
            renderStops();
          } else gotoSource(breakpoints[index].file, breakpoints[index].line);
        }),
    );
  $("watches").innerHTML = watches
    .map(
      (w, i) =>
        `<button class="bp" data-watch="${i}">${w.access} ${esc(w.register || hex(w.address))} ×</button>`,
    )
    .join("");
  $("watches")
    .querySelectorAll("[data-watch]")
    .forEach(
      (b) =>
        (b.onclick = () => {
          watches.splice(Number(b.dataset.watch), 1);
          renderStops();
        }),
    );
}
async function run(mode = "run", extra = {}) {
  if (busy || dirty) return;
  running = true;
  updateControls();
  let first = true;
  const demonstrate = mode === "run" && !$("fast-run").checked;
  while (running) {
    let s = await command(mode, {
      limit:
        mode === "run"
          ? demonstrate
            ? 1
            : 150
          : mode === "over" || mode === "out"
            ? 100000
            : 1000,
      breakpoints,
      watches,
      skipBreakpoint: first,
      ...extra,
    });
    first = false;
    if (demonstrate && s?.last) {
      followPC();
      for (let i = 0; i < player.actions.length && running; i++) {
        player.seek(i);
        await new Promise((resolve) => setTimeout(resolve, 650));
      }
    }
    if (
      !s ||
      s.status !== "paused" ||
      s.stopReason !== "Batch complete" ||
      mode !== "run"
    )
      break;
    await new Promise((r) => setTimeout(r, 0));
  }
  running = false;
  followPC();
  updateControls();
}
async function runUntilWrite(register) {
  await run("run", { watches: [...watches, { register, access: "write" }] });
}
function ask(title, value, callback) {
  modal(
    title,
    `<form id="ask-form"><input id="ask-value" style="width:100%" value="${esc(value)}" autofocus><p><button class="primary">确定</button></p></form>`,
  );
  $("ask-form").onsubmit = (e) => {
    e.preventDefault();
    let v = $("ask-value").value;
    $("modal").close();
    callback(v);
  };
  $("ask-value").focus();
}
function editData(name) {
  modal(
    "虚拟文件 · " + name,
    `<textarea id="data-edit" aria-label="虚拟文件内容">${esc(data[name])}</textarea><button id="data-save" class="primary">保存并重新汇编</button><button id="data-delete">删除文件</button>`,
  );
  $("data-save").onclick = () => {
    data[name] = $("data-edit").value;
    $("modal").close();
    assemble();
  };
  $("data-delete").onclick = () => {
    delete data[name];
    $("modal").close();
    assemble();
  };
}
function openCommands() {
  const commands = [
    ["汇编工程", assemble],
    ["机器单步", () => command("step").then(followPC)],
    ["源码单步", () => run("source")],
    ["跨过调用", () => run("over")],
    ["跳出函数", () => run("out")],
    ["回退一步", () => command("back").then(followPC)],
    ["运行／暂停", () => (running ? (running = false) : run())],
    [
      "运行到光标",
      () => {
        let address = lineAddress(
          editor.state.doc.lineAt(editor.state.selection.main.head).number,
        );
        if (address != null)
          run("run", {
            breakpoints: [...breakpoints, { address, condition: "" }],
          });
      },
    ],
    ["查看实际指令", () => setView("machine")],
    ["查看控制流", () => setView("cfg")],
    [
      "显示全部寄存器",
      () => {
        $("reg-filter").value = "all";
        renderRegisters();
      },
    ],
    ["输入地址／符号", () => $("address").focus()],
    [
      "切换实线叠加",
      () => {
        $("solid").checked = !$("solid").checked;
        overlay.schedule();
      },
    ],
    [
      "切换虚线叠加",
      () => {
        $("dashed").checked = !$("dashed").checked;
        overlay.schedule();
      },
    ],
    ["syscall 服务表", () => inspectToken("syscall")],
  ];
  modal(
    "命令面板",
    `<input id="command-filter" placeholder="搜索命令…" style="width:100%">${commands.map(([n], i) => `<button class="command-item" data-command="${i}">${n}</button>`).join("")}`,
  );
  $("command-filter").oninput = (e) =>
    document
      .querySelectorAll("[data-command]")
      .forEach((b) => (b.hidden = !b.textContent.includes(e.target.value)));
  document.querySelectorAll("[data-command]").forEach(
    (b) =>
      (b.onclick = () => {
        $("modal").close();
        commands[Number(b.dataset.command)][1]();
      }),
  );
  $("command-filter").focus();
}
$("assemble").onclick = assemble;
$("step").onclick = () => command("step").then(followPC);
$("back").onclick = () => command("back").then(followPC);
for (let mode of ["source", "over", "out", "run"])
  $(mode).onclick = () => run(mode);
$("pause").onclick = () => {
  running = false;
  player.stop();
  updateControls();
};
$("commands").onclick = openCommands;
$("theme").onclick = () => {
  document.body.classList.toggle("dark");
  overlay.schedule();
};
$("zoom").onclick = () => {
  fontSize = fontSize >= 19 ? 13 : fontSize + 2;
  document.documentElement.style.setProperty("--code", fontSize + "px");
  editor.requestMeasure();
  overlay.schedule();
};
$("clear-focus").onclick = () => {
  focus = null;
  inspecting = null;
  renderRegisters();
  overlay.schedule();
};
$("reg-filter").onchange = () => {
  renderRegisters();
  overlay.schedule();
};
$("symbol-search").oninput = renderSymbols;
$("delay").onchange = () => {
  dirty = true;
  notify("运行配置已修改，请重新汇编");
  updateControls();
};
for (let id of ["solid", "dashed", "reads", "writes", "flows"])
  $(id).onchange = () => overlay.schedule();
document
  .querySelectorAll("[data-view]")
  .forEach((b) => (b.onclick = () => setView(b.dataset.view)));
document
  .querySelectorAll("[data-bottom]")
  .forEach((b) => (b.onclick = () => setBottom(b.dataset.bottom)));
$("input-form").onsubmit = async (e) => {
  e.preventDefault();
  let value = $("stdin").value;
  $("stdin").value = "";
  await command("input", { value });
};
$("memory-form").onsubmit = (e) => {
  e.preventDefault();
  let text = $("address").value,
    s = program.symbols.find((s) => s.name === text),
    value = s ? s.address : Number(text);
  if (Number.isFinite(value)) memoryAt(value);
  else notify("请输入有效地址或标签");
};
$("stack").onclick = () => memoryAt(regValue("$sp") - 16);
$("data").onclick = () => memoryAt(0x10010000);
$("new-file").onclick = () =>
  ask("新建源码文件", "new.s", (name) => {
    if (name && !files[name]) {
      files[name] = ".text\n";
      switchFile(name);
      dirty = true;
      updateControls();
    }
  });
$("add-watch").onclick = () => {
  modal(
    "添加读写观察点",
    `<form id="watch-form"><input id="watch-target" value="$t0" aria-label="观察对象"><select id="watch-access"><option value="write">写入</option><option value="read">读取</option><option value="both">读／写</option></select><button class="primary">添加</button></form>`,
  );
  $("watch-form").onsubmit = (e) => {
    e.preventDefault();
    let value = $("watch-target").value,
      access = $("watch-access").value;
    if (value.startsWith("$"))
      watches.push({ register: canonicalReg(value), access });
    else if (Number.isFinite(Number(value)))
      watches.push({ address: Number(value) | 0, access });
    $("modal").close();
    renderStops();
  };
};
$("import").onclick = () => $("upload").click();
$("upload").onchange = async (e) => {
  for (let f of e.target.files) {
    let text = await f.text();
    if (f.name.endsWith(".json")) {
      let project = JSON.parse(text);
      files = project.files || files;
      data = project.data || {};
    } else if (/\.(s|asm)$/.test(f.name)) files[f.name] = text;
    else data[f.name] = text;
  }
  activeFile = "";
  switchFile(Object.keys(files)[0]);
  await assemble();
};
$("save").onclick = () => {
  savedEditor();
  let blob = new Blob(
      [
        JSON.stringify(
          { version: 1, files, data, delay: $("delay").checked },
          null,
          2,
        ),
      ],
      { type: "application/json" },
    ),
    a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "mars-project.json";
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};
$("example").onchange = () => loadExample(Number($("example").value));
document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
    e.preventDefault();
    openCommands();
  }
  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
    e.preventDefault();
    assemble();
  }
  if (e.key === "F7") {
    e.preventDefault();
    $("step").click();
  }
  if (e.key === "F8") {
    e.preventDefault();
    $("over").click();
  }
  if (e.key === "F9") {
    e.preventDefault();
    running ? $("pause").click() : $("run").click();
  }
  if (e.altKey && e.key === "ArrowLeft") {
    e.preventDefault();
    $("back").click();
  }
});
async function loadExample(index) {
  let p = exampleList[index];
  files = { ...p.files };
  data = { ...p.data };
  activeFile = "";
  breakpoints = [];
  watches = [];
  fileStates.clear();
  switchFile(p.entry);
  await assemble();
}
try {
  exampleList = await (await fetch("/examples")).json();
  $("example").innerHTML = exampleList
    .map(
      (e, i) =>
        `<option value="${i}">${esc(e.name === "hexout" ? "Hexadecimal · 位与字符" : e.name === "task1" ? "Task 1 · 文件与调用" : e.name)}</option>`,
    )
    .join("");
  $("example").value = String(
    Math.max(
      0,
      exampleList.findIndex((e) => e.name === "hexout"),
    ),
  );
  await loadExample(Number($("example").value));
} catch (e) {
  notify("无法连接执行服务：" + e.message);
}
window.marsIDE = {
  get state() {
    return state;
  },
  get program() {
    return program;
  },
  editor,
  inspectToken,
  gotoAddress,
  memoryAt,
  command,
  assemble,
  run,
  loadExample,
  get files() {
    return files;
  },
  get overlay() {
    return overlay;
  },
};
