import {
  EditorView,
  Decoration,
  ViewPlugin,
  GutterMarker,
  WidgetType,
  gutter,
  keymap,
} from "@codemirror/view";
import { EditorState, StateEffect, StateField } from "@codemirror/state";
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
  splitComment,
  nameRegisters,
} from "./model.js";
import { OverlayRenderer } from "./overlay.js";
import { FocusLens } from "./focus.js";
import { Keymap, label as keyLabel } from "./keymap.js";
import { quickOpenItems } from "./search.js";
import {
  formatValue,
  RADIXES,
  RADIX_HELP,
  addressRegisters,
  escapeByte,
} from "./radix.js";
import { termsIn } from "./glossary.js";
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
  debugLog = [],
  watches = [],
  exampleList = [],
  fontSize = 13;
let inspecting = null,
  program = { instructions: [], symbols: [], instructionDocs: {} },
  fileStates = new Map(),
  loadEditor = false;
const refresh = StateEffect.define();
// Breakpoint marker: ● plain, ◉ conditional or hit count, ◆ logpoint, ○ disabled.
function breakpointGlyph(b) {
  if (!b) return "·";
  if (!b.enabled) return "○";
  if (b.log) return "◆";
  return b.condition || b.hit ? "◉" : "●";
}
class Dot extends GutterMarker {
  constructor(breakpoint) {
    super();
    this.breakpoint = breakpoint;
  }
  toDOM() {
    let e = document.createElement("span");
    e.className =
      "break-dot" + (this.breakpoint && !this.breakpoint.enabled ? " off" : "");
    e.textContent = breakpointGlyph(this.breakpoint);
    return e;
  }
}
function lineAddress(line) {
  return program.instructions.find(
    (i) => i.file === activeFile && i.line === line,
  )?.address;
}
// A label line has no instruction of its own; it stands for the first
// instruction after it (round-2 trial: F9 on "loop:" failed).
function breakableAddress(line) {
  const own = lineAddress(line);
  if (own != null) return { address: own, line };
  const text = editor.state.doc.line(line).text.split("#")[0];
  if (!/^\s*[A-Za-z_.$][\w.$]*\s*:/.test(text)) return null;
  const next = program.instructions
    .filter((i) => i.file === activeFile && i.line > line)
    .sort((a, b) => a.line - b.line || a.address - b.address)[0];
  return next ? { address: next.address, line: next.line, label: true } : null;
}
// Inline execution values (DESIGN §3.8): what the most recent run of each
// recently executed line wrote, as of the selected history state.
const INLINE_LINES = 12;
let inlineCache = { key: null, map: new Map() };
// A nop right after a branch or jump keeps the program correct when delayed
// branching is on; otherwise it does nothing. Shown dimmed with its reason (C5).
const DELAY_NOP =
  "延迟槽占位：开启“延迟分支”时，跳转或分支后面紧跟的这一条总会先执行，放 nop 可以保证程序在两种设置下都正确。关闭时它什么也不做。";
let delayCache = { program: null, lines: new Set() };
function delaySlots() {
  if (delayCache.program === program.instructions) return delayCache.lines;
  const by = new Map(program.instructions.map((i) => [i.address, i])),
    lines = new Set();
  for (const i of program.instructions)
    if (
      i.op === "nop" &&
      by.get(i.address - 4)?.flow !== "next" &&
      by.has(i.address - 4)
    )
      lines.add(i.file + ":" + i.line);
  delayCache = { program: program.instructions, lines };
  return lines;
}
// Global read-only radix (C2), remembered per viewer.
let radix = "auto";
try {
  radix = localStorage.getItem("radix") || "auto";
} catch {}
const fmt = (n, width = 4, kind = "value") =>
  formatValue(n, { radix, width, kind });
const regKind = (name) => (addressRegisters.has(name) ? "address" : "value");
function inlineValues() {
  const key = dirty
    ? "dirty"
    : `${state?.programVersion}:${state?.step}:${radix}`;
  if (inlineCache.key === key) return inlineCache.map;
  const map = new Map(),
    closed = new Set();
  const events = (state?.trace || []).filter(
    (e) => !dirty && e.step <= state.step,
  );
  let open = null;
  for (let i = events.length - 1; i >= 0 && map.size <= INLINE_LINES; i--) {
    const ins = events[i].instruction,
      line = ins.file + ":" + ins.line;
    if (line !== open) {
      if (open) closed.add(open);
      open = closed.has(line) ? null : line;
    }
    if (!open) continue;
    const writes = map.get(line) || new Map();
    for (const a of events[i].accesses)
      if (a.write) {
        const name = a.kind === "register" ? a.name : `[${hex(a.address)}]`;
        // Walking backwards, the first write seen per object is its final value.
        if (!writes.has(name)) {
          const f =
            a.kind === "memory"
              ? fmt(a.value, a.width, "bits")
              : fmt(a.value, 4, regKind(a.name));
          writes.set(name, f.text + (f.note ? " " + f.note : ""));
        }
      }
    map.set(line, writes);
  }
  for (const [line, writes] of map)
    if (writes.size)
      map.set(
        line,
        [...writes]
          .reverse()
          .map(([n, v]) => `${n} = ${v}`)
          .join("  "),
      );
    else map.delete(line);
  inlineCache = { key, map };
  return map;
}
class InlineValue extends WidgetType {
  constructor(text) {
    super();
    this.text = text;
  }
  eq(other) {
    return other.text === this.text;
  }
  // Long results are cut with an ellipsis; the whole text is on hover
  // (round-2 trial: values ran off the right edge).
  toDOM() {
    const span = document.createElement("span");
    span.className = "cm-inline-value";
    span.textContent =
      this.text.length > 48 ? this.text.slice(0, 47) + "…" : this.text;
    span.title = this.text;
    return span;
  }
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
          const slot = delaySlots().has(activeFile + ":" + l.number);
          if (slot) cls.push("delay-nop");
          if (cls.length)
            ranges.push(
              Decoration.line({
                class: cls.join(" "),
                attributes: slot ? { title: DELAY_NOP } : {},
              }).range(l.from),
            );
          const inline = inlineValues().get(activeFile + ":" + l.number);
          if (inline)
            ranges.push(
              Decoration.widget({
                widget: new InlineValue(inline),
                side: 1,
              }).range(l.to),
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
// Peek references (Shift+F12): an inline panel under the line, VS Code style.
const setPeek = StateEffect.define();
class PeekWidget extends WidgetType {
  constructor(peek) {
    super();
    this.peek = peek;
  }
  eq(other) {
    return other.peek === this.peek;
  }
  toDOM() {
    const { token, refs } = this.peek,
      box = document.createElement("div");
    box.className = "cm-peek";
    box.innerHTML =
      `<div class="cm-peek-head"><b>${esc(token)}</b> · ${refs.length} 处引用<button data-peek-close aria-label="关闭">×</button></div>` +
      (refs.length
        ? refs
            .map(
              (r, i) =>
                `<button class="cm-peek-row" data-peek="${i}"><span>${esc(r.file)}:${r.line}</span><small>${esc(r.type)}</small><code>${esc(r.text.trim())}</code></button>`,
            )
            .join("")
        : '<p class="muted">无静态引用。</p>');
    box.querySelector("[data-peek-close]").onclick = () => closePeek();
    // Keyboard: ↑/↓ move through the list (it scrolls), Enter opens, Esc returns.
    box.addEventListener("keydown", (e) => {
      const rows = [...box.querySelectorAll("[data-peek]")],
        i = rows.indexOf(document.activeElement);
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        e.stopPropagation();
        rows[
          Math.max(
            0,
            Math.min(rows.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)),
          )
        ]?.focus();
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        closePeek();
        editor.focus();
      }
    });
    box.querySelectorAll("[data-peek]").forEach(
      (b) =>
        (b.onclick = () => {
          const r = refs[Number(b.dataset.peek)];
          closePeek();
          gotoSource(r.file, r.line);
        }),
    );
    return box;
  }
}
const peekField = StateField.define({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setPeek)) return e.value;
    return tr.docChanged ? null : value;
  },
  provide: (field) =>
    EditorView.decorations.from(field, (peek) =>
      peek
        ? Decoration.set([
            Decoration.widget({
              widget: new PeekWidget(peek),
              block: true,
              side: 1,
            }).range(peek.pos),
          ])
        : Decoration.none,
    ),
});
function peekReferences() {
  const head = editor.state.selection.main.head,
    token = tokenAt(head);
  if (!token) return;
  editor.dispatch({
    effects: setPeek.of({
      token,
      refs: references(files, token),
      pos: editor.state.doc.lineAt(head).to,
    }),
  });
  requestAnimationFrame(() =>
    editor.dom.querySelector(".cm-peek-row")?.focus({ preventScroll: true }),
  );
}
// Editor right-click menu: run to here and the line's breakpoint and queries.
function editorMenu(x, y, pos) {
  closeMenu();
  $("tooltip").hidden = true;
  const line = editor.state.doc.lineAt(pos).number,
    address = breakableAddress(line)?.address ?? null,
    token = tokenAt(pos),
    canRun = !dirty && ["paused", "waiting"].includes(state?.status);
  editor.dispatch({ selection: { anchor: pos } });
  const items = [
    [
      "运行到此行",
      canRun && address != null,
      () => run("run", { breakpoints: [...activeBreakpoints(), { address }] }),
    ],
    ["切换断点", address != null, () => toggleBreakpoint(line), "breakpoint"],
    ["编辑断点…", address != null, () => editBreakpoint(address)],
    ["转到定义／说明", !!token, () => inspectToken(token)],
    ["查看引用", !!token, () => peekReferences()],
  ];
  const menu = document.createElement("div");
  menu.id = "context-menu";
  menu.setAttribute("role", "menu");
  menu.innerHTML = items
    .map(
      ([name, enabled, , action], i) =>
        `<button role="menuitem" data-menu="${i}" ${enabled ? "" : "disabled"}>${esc(name)}${action && keys.find(action) ? `<kbd>${keyLabel(keys.find(action), mac)}</kbd>` : ""}</button>`,
    )
    .join("");
  document.body.appendChild(menu);
  const r = menu.getBoundingClientRect();
  menu.style.left = Math.min(x, innerWidth - r.width - 8) + "px";
  menu.style.top = Math.min(y, innerHeight - r.height - 8) + "px";
  menu.querySelectorAll("[data-menu]").forEach(
    (b) =>
      (b.onclick = () => {
        closeMenu();
        items[Number(b.dataset.menu)][2]();
      }),
  );
  menu.querySelector("button:not([disabled])")?.focus();
  setTimeout(() => {
    document.addEventListener("pointerdown", closeMenuOutside, true);
    document.addEventListener("keydown", closeMenuOnEscape, true);
  });
}
function closeMenu() {
  document.getElementById("context-menu")?.remove();
  document.removeEventListener("pointerdown", closeMenuOutside, true);
  document.removeEventListener("keydown", closeMenuOnEscape, true);
}
function closeMenuOutside(e) {
  if (!e.target.closest("#context-menu")) closeMenu();
}
function closeMenuOnEscape(e) {
  if (e.key === "Escape") {
    e.stopPropagation();
    closeMenu();
    editor.focus();
  }
}
function closePeek() {
  if (editor.state.field(peekField))
    editor.dispatch({ effects: setPeek.of(null) });
}
const breakpointGutter = gutter({
  class: "breakpoints-gutter",
  lineMarker: (v, line) =>
    new Dot(
      breakpoints.find(
        (b) =>
          b.file === activeFile &&
          b.line === v.state.doc.lineAt(line.from).number,
      ),
    ),
  initialSpacer: () => new Dot(null),
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
      peekField,
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
        {
          key: "Shift-F12",
          run: () => {
            peekReferences();
            return true;
          },
        },
        {
          key: "Escape",
          run: () => {
            if (!editor.state.field(peekField)) return false;
            closePeek();
            return true;
          },
        },
      ]),
      EditorView.updateListener.of((u) => {
        if (u.docChanged && !loadEditor) {
          files[activeFile] = u.state.doc.toString();
          dirty = true;
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
        contextmenu: (e) => {
          let pos = editor.posAtCoords({ x: e.clientX, y: e.clientY });
          if (pos == null) return false;
          e.preventDefault();
          editorMenu(e.clientX, e.clientY, pos);
          return true;
        },
      }),
    ],
  }),
  parent: $("editor"),
});
const overlay = new OverlayRenderer({
  getState: () => (dirty ? null : state ? { ...state, ...program } : null),
  getEditor: () => editor,
  getFile: () => activeFile,
  getView: () => view,
  getFocus: () => focus,
  onAddress: (a) => memoryAt(a),
  onSource: (a) => gotoAddress(a),
});
const lens = new FocusLens({
  getState: () => (dirty ? null : state),
  getProgram: () => program,
  getSource: (file, line) => files[file]?.split("\n")[line - 1],
  command: (name, extra) => command(name, extra).then((s) => (followPC(), s)),
  runSource: () => run("source"),
  // Exactly n machine instructions: one batch, still stopping at breakpoints.
  runSteps: (n) =>
    command("run", {
      limit: n,
      breakpoints: activeBreakpoints(),
      watches,
      skipBreakpoint: true,
    }),
  toggleBreakpoint: (address) => toggleAddressBreakpoint(address),
  hasBreakpoint: (address) => breakpoints.some((b) => b.address === address),
  isRunning: () => running,
  getRadix: () => radix,
  submitInput: (value) => submitInput(value),
  isBusy: () => busy,
  onClose: () => {
    followPC();
    overlay.schedule();
  },
});
// Lookahead is only computed while the lens shows it (DESIGN §4).
const lookahead = () =>
  lens.isOpen ? { lookahead: lens.lookaheadLines() } : {};
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
    return `<b>${esc(token)}</b> ${esc(fmt(regValue(token), 4, regKind(token)).text)}<p>${esc(role(token))}</p><small>当前快照 S${state?.step ?? 0} · Cmd/Ctrl＋点击固定</small>`;
  if (token === "syscall") {
    let n = regValue("$v0"),
      s = services[n];
    return `<b>syscall ${n} · ${s?.[0] || "未支持服务"}</b><p>参数 ${s?.[1].join(", ") || "无"}；结果 ${s?.[2].join(", ") || "无"}</p>`;
  }
  if (explanations[token] || program.instructionDocs[token]) {
    const text =
      explanations[token] || program.instructionDocs[token].description;
    return `<b>${esc(token)}</b><p>${esc(text)}</p>${definitions(text)}<small>指令／汇编器说明</small>`;
  }
  let symbol = program.symbols.find((s) => s.name === token);
  if (symbol)
    return `<b>${esc(token)}</b><p>符号地址 ${hex(symbol.address)}</p><small>Cmd/Ctrl＋点击跳转定义</small>`;
  return `<b>${esc(token)}</b><p>点击查询地址或源码引用</p>`;
}
// Term definitions under a tooltip (it moves with the pointer, so its words
// cannot be hovered themselves).
function definitions(text) {
  const terms = termsIn(text);
  return terms.length
    ? `<dl class="defs">${terms.map(([t, d]) => `<dt>${esc(t)}</dt><dd>${esc(d)}</dd>`).join("")}</dl>`
    : "";
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
// transient: the notice clears itself after a few seconds (trial round 2:
// a stale notice stayed on screen and was read as current).
function notify(message, { transient = false } = {}) {
  $("banner").textContent = message;
  $("banner").className = message ? "visible" : "";
  clearTimeout(notify.timer);
  if (transient && message)
    notify.timer = setTimeout(() => {
      if ($("banner").textContent === message) notify("");
    }, 4000);
}
// Every instruction the backend reports is shown with register names (C3).
function named(s) {
  const fix = (i) => {
    if (i?.basic && !i.named) {
      i.basic = nameRegisters(i.basic);
      i.named = true;
    }
  };
  (s.instructions || []).forEach(fix);
  for (const e of [
    s.last,
    s.preview,
    ...(s.trace || []),
    ...(s.calls || []),
    ...(s.lookahead?.groups || []).flatMap((g) => g.events),
  ])
    fix(e?.instruction);
  return s;
}
// The line a student wrote for an instruction (a pseudo-instruction's
// expansion carries no source of its own), without its comment.
function sourceOf(ins) {
  if (!ins) return "";
  const line =
    program.instructions.find(
      (i) => i.file === ins.file && i.line === ins.line && i.source,
    )?.source ||
    ins.source ||
    "";
  return splitComment(line).code || ins.basic;
}
async function api(body) {
  let r = await fetch("/api", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    s = await r.json();
  if (!r.ok || !s.protocol) throw Error(s.error || "执行服务未返回状态");
  return named(s);
}
async function command(name, extra = {}) {
  if (busy) return null;
  busy = true;
  updateControls();
  try {
    let s = await api({
      command: name,
      programVersion: state?.programVersion,
      ...lookahead(),
      ...extra,
    });
    state = s;
    appendLogs(s.logs);
    render();
    lens.update(dirty ? null : state);
    return s;
  } catch (e) {
    notify(e.message);
    if (running) stopRequested = true;
    return null;
  } finally {
    busy = false;
    updateControls();
  }
}
async function assemble() {
  await requestStop();
  if (busy) return;
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
      ...lookahead(),
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
    debugLog = [];
    notify(state.error || "");
    render();
    followPC();
    lens.update(state);
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
// Cursor navigation history (VS Code Go Back / Go Forward). Following the PC
// is not a navigation and passes record = false.
const navBack = [],
  navForward = [];
function here() {
  return activeFile
    ? { file: activeFile, pos: editor.state.selection.main.head }
    : null;
}
function restorePlace(place) {
  if (!place || !files.hasOwnProperty(place.file)) return;
  if (place.file !== activeFile) switchFile(place.file);
  setView("source");
  const pos = Math.min(place.pos, editor.state.doc.length);
  editor.dispatch({
    selection: { anchor: pos },
    effects: EditorView.scrollIntoView(pos, { y: "center" }),
  });
  editor.focus();
}
function navigate(direction) {
  const [from, to] =
    direction < 0 ? [navBack, navForward] : [navForward, navBack];
  const place = from.pop();
  if (!place) return;
  const current = here();
  if (current) to.push(current);
  restorePlace(place);
}
function gotoSource(file, line, record = true) {
  if (!files.hasOwnProperty(file)) return;
  const before = here();
  if (record && before) {
    navBack.push(before);
    if (navBack.length > 50) navBack.shift();
    navForward.length = 0;
  }
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
// Where execution just stopped, shown without words (trial A5, variants A+B):
// the next line pulses on every stop; after a run, a file change or a jump the
// rest of the code also dims for a moment so the eye lands on it.
let arrivedAt = null;
function arrive(jumped = false) {
  const ins = program.instructions.find((i) => i.address === state?.pc);
  if (!ins || view !== "source" || dirty) return;
  const far =
    jumped ||
    !arrivedAt ||
    arrivedAt.file !== ins.file ||
    Math.abs(arrivedAt.line - ins.line) > 1;
  arrivedAt = { file: ins.file, line: ins.line };
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  requestAnimationFrame(() => {
    const line = editor.dom.querySelector(".cm-line.next-line");
    line?.animate(
      [
        { background: "color-mix(in srgb, var(--blue) 40%, var(--panel))" },
        { background: "color-mix(in srgb, var(--blue) 12%, transparent)" },
      ],
      { duration: 900, iterations: 2, easing: "ease-out" },
    );
    if (!far) return;
    editor.dom.classList.add("arrival-spotlight");
    clearTimeout(arrive.timer);
    arrive.timer = setTimeout(
      () => editor.dom.classList.remove("arrival-spotlight"),
      1100,
    );
  });
}
// Moving to another file while following execution is easy to miss; say where
// execution went and flash the tab.
let keepNotice = false;
function followPC() {
  let ins = program.instructions.find((i) => i.address === state?.pc);
  if (ins && view === "source" && ins.file !== activeFile && activeFile) {
    const label = program.symbols
      .filter((s) => !s.data && s.address <= ins.address)
      .filter(
        (s) =>
          program.instructions.find((i) => i.address === s.address)?.file ===
          ins.file,
      )
      .sort((a, b) => b.address - a.address)[0];
    gotoSource(ins.file, ins.line, false);
    notify(`执行进入 ${ins.file}${label ? " · " + label.name : ""}`);
    keepNotice = true;
    clearTimeout(followPC.timer);
    followPC.timer = setTimeout(() => (keepNotice = false), 2500);
    document
      .querySelector(".tabs .active")
      ?.animate(
        [
          { background: "color-mix(in srgb, var(--accent) 30%, var(--panel))" },
          { background: "transparent" },
        ],
        { duration: 900 },
      );
  } else if (ins && view === "source") gotoSource(ins.file, ins.line, false);
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
  if (v === "logs") $("logs-tab").classList.remove("unread");
  for (let name of ["console", "trace", "calls", "problems", "logs"])
    $(name).hidden = name !== v;
  document
    .querySelectorAll("[data-bottom]")
    .forEach((b) => b.classList.toggle("selected", b.dataset.bottom === v));
}
// What the machine is doing and why it stopped, in the student's words
// (DESIGN P06: a breakpoint stops *before* its line runs).
function statusInfo() {
  const where = (address) => {
    const i = program.instructions.find((x) => x.address === address);
    return i
      ? { file: i.file, line: i.line, text: `${i.file} 第 ${i.line} 行` }
      : null;
  };
  if (dirty) return { kind: "dirty", text: "源码已修改 · 重新汇编后继续" };
  if (!state || state.status === "empty")
    return { kind: "idle", text: "未汇编" };
  if (running)
    return {
      kind: "running",
      text: stopRequested ? "正在暂停…" : `运行中 · 第 ${state.step} 步`,
    };
  const next = where(state.pc),
    last = state.last ? where(state.last.pc) : null,
    reason = state.stopReason || "";
  if (state.status === "waiting")
    return {
      kind: "waiting",
      text: "等待输入 · 在控制台输入后按 Enter",
      at: next,
    };
  if (state.status === "ended")
    return { kind: "ended", text: `已结束 · 退出码 ${state.exitCode}` };
  if (state.status === "error")
    return {
      kind: "error",
      text: "出错 · " + (state.error || "").split("\n")[0].slice(0, 80),
      at: last,
    };
  if (reason.startsWith("Breakpoint") && next)
    return {
      kind: "breakpoint",
      text: `停在断点前 · ${next.text}（这一行还没执行）· 即将第 ${state.pcVisits} 次执行`,
      at: next,
    };
  if (reason.startsWith("Watchpoint") && last)
    return {
      kind: "breakpoint",
      text: `观察点触发 · 刚执行的 ${last.text}${reason.endsWith("read") ? "读取" : "写入"}了被观察的对象`,
      at: last,
    };
  if (reason.startsWith("History limit"))
    return { kind: "error", text: "已达到历史上限 100000 步 · 重新汇编后继续" };
  if (reason.startsWith("History"))
    return {
      kind: "paused",
      text: `回放历史 · 已执行 ${state.step} / ${state.historyLength} 步`,
      at: next,
    };
  if (!state.step && next)
    return { kind: "paused", text: `就绪 · 从 ${next.text} 开始`, at: next };
  return {
    kind: "paused",
    text: last ? `已暂停 · 刚执行 ${last.text}` : "已暂停",
    at: next,
  };
}
function updateControls() {
  for (let name of ["step", "source", "over", "out", "run", "demo"])
    $(name).disabled =
      busy ||
      dirty ||
      running ||
      !state ||
      !["paused", "waiting"].includes(state.status);
  $("back").disabled = busy || dirty || running || !state?.step;
  $("assemble").disabled = busy;
  $("pause").disabled = !running;
  const info = statusInfo();
  $("status").textContent = info.text;
  $("status").dataset.state = info.kind;
  $("status").onclick = info.at
    ? () => gotoSource(info.at.file, info.at.line)
    : null;
  $("status").title = info.at ? "点击跳到这一行" : "";
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
        `<div tabindex="0" class="reg ${all.some((a) => a.name === r.name && !a.write) ? "read" : ""} ${all.some((a) => a.name === r.name && a.write) ? "write" : ""} ${pinned.has(r.name) ? "pinned" : ""} ${focus === r.name ? "focus" : ""}" data-register="${r.name}" title="${r.name} · ${esc(role(r.name))}\n${esc(fmt(r.value, 4, regKind(r.name)).full)} · 点击查看"><span class="name">${r.name}</span><span>${esc(fmt(r.value, 4, regKind(r.name)).text)}</span></div>`,
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
      `<div class="mem-row"><span class="mem-address">${hex(bytes[0].address).slice(2)}</span>${bytes.map((b) => `<span tabindex="0" class="byte ${all.some((a) => !a.write && b.address >= a.address && b.address < a.address + a.width) ? "read" : ""} ${all.some((a) => a.write && b.address >= a.address && b.address < a.address + a.width) ? "write" : ""} ${focus === "mem:" + b.address ? "focus" : ""}" data-byte="${b.address}" title="${hex(b.address)} · ${b.value == null ? "" : esc(formatValue(b.value, { radix: radix === "auto" ? "hex" : radix, width: 1, kind: "bits" }).text)}">${b.value == null ? "??" : esc(memoryCell(b.value))}</span>`).join("")}<span class="ascii">${bytes.map((b) => (b.value >= 32 && b.value < 127 ? esc(String.fromCharCode(b.value)) : ".")).join("")}</span></div>`,
    );
  }
  $("memory").innerHTML = rows.join("");
  $("memory").dataset.radix = radix;
  $("mem-radix").textContent = {
    auto: "单元 0x",
    hex: "单元 0x",
    dec: "单元 0d",
    bin: "单元 0b",
    ascii: "单元 字符",
  }[radix];
  $("memory")
    .querySelectorAll("[data-byte]")
    .forEach((e) => {
      e.onclick = () => inspectByte(Number(e.dataset.byte));
      e.onkeydown = (k) => {
        if (k.key === "Enter") e.click();
      };
    });
}
// Memory cells are too narrow for prefixes; the panel header shows the radix.
function memoryCell(v) {
  if (radix === "dec") return String(v);
  if (radix === "bin") return v.toString(2).padStart(8, "0");
  if (radix === "ascii")
    return v >= 32 && v < 127
      ? String.fromCharCode(v)
      : formatValue(v, { radix: "ascii", width: 1 }).text.slice(1, -1);
  return v.toString(16).padStart(2, "0");
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
  let last = state?.last,
    next = state?.preview;
  $("last-card").innerHTML =
    `<small>刚完成 ${last ? "#" + last.step : ""} · 实线</small><b>${esc(last?.instruction ? sourceOf(last.instruction) : "尚无执行记录")}</b>`;
  $("next-card").innerHTML =
    `<small>即将执行 ${next?.instruction ? "#" + next.step : ""} · 虚线 ${next?.status === "waiting-input" ? "· 等待输入" : ""}</small><b>${esc(next?.instruction ? sourceOf(next.instruction) : "—")}</b>`;
  for (let [id, e] of [
    ["last-card", last],
    ["next-card", next],
  ]) {
    // The machine instruction actually executed is one hover away.
    $(id).title = e?.instruction
      ? `${e.instruction.file}:${e.instruction.line} · ${hex(e.pc)}\n实际执行：${e.instruction.basic}`
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
        `<div class="instruction ${i.address === state?.pc ? "next" : ""} ${i.address === state?.last?.pc ? "last" : ""}" data-instruction="${i.address}"><span data-machine-bp="${i.address}">${breakpointGlyph(breakpoints.find((b) => b.address === i.address))}</span><span>${hex(i.address).slice(2)}</span><span>${esc(i.basic)}</span><small>${esc(i.file)}:${i.line} · ${hex(i.binary)} · ${esc(i.source?.trim())}</small></div>`,
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
  renderLogs();
  renderOutput();
  $("pc").textContent = "PC " + hex(state.pc);
  // "第 N 步" in explanations is the Nth execution, so the state reads as how
  // many steps have run (round-2 trial: S13 vs 第 14 步 looked inconsistent).
  $("location").textContent =
    `已执行 ${state.step} 步 · 下一条 ${hex(state.pc)}`;
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
  } else if (!dirty && !keepNotice) notify("");
  editor.dispatch({ effects: refresh.of(null) });
  if (view === "machine") renderMachine();
  if (view === "cfg") renderCFG();
  if (inspecting?.startsWith("$")) inspectToken(inspecting);
  overlay.schedule();
  updateControls();
}
// Breakpoints carry VS Code's options: enabled, condition, hit count (pause
// before the Nth execution since S0) and logpoint message (log, don't pause).
function activeBreakpoints() {
  return breakpoints
    .filter((b) => b.enabled)
    .map(({ address, condition, hit, log }) => ({
      address,
      condition,
      hit,
      log,
    }));
}
function breakpointChanged() {
  renderStops();
  editor.dispatch({ effects: refresh.of(null) });
  if (view === "machine") renderMachine();
}
function toggleAddressBreakpoint(address, edit = false) {
  let ins = program.instructions.find((i) => i.address === address);
  if (!ins) return;
  if (edit) return editBreakpoint(address);
  let i = breakpoints.findIndex((b) => b.address === address);
  if (i >= 0) breakpoints.splice(i, 1);
  else
    breakpoints.push({
      address,
      file: ins.file,
      line: ins.line,
      enabled: true,
      condition: "",
      hit: 0,
      log: "",
    });
  breakpointChanged();
}
function editBreakpoint(address) {
  let ins = program.instructions.find((i) => i.address === address);
  if (!ins) return;
  let b = breakpoints.find((x) => x.address === address) || {
    address,
    file: ins.file,
    line: ins.line,
    enabled: true,
    condition: "",
    hit: 0,
    log: "",
  };
  modal(
    `断点 · ${ins.file}:${ins.line}`,
    `<form id="bp-form" class="bp-form">
      <label><input type="checkbox" id="bp-enabled" ${b.enabled ? "checked" : ""}> 启用</label>
      <label>条件<input id="bp-condition" value="${esc(b.condition)}" placeholder="$t0 == 3（$寄存器 与整数比较）"></label>
      <label>命中次数<input id="bp-hit" type="number" min="0" value="${b.hit || ""}" placeholder="第 N 次执行前暂停；留空表示每次"></label>
      <label>日志消息<input id="bp-log" value="${esc(b.log)}" placeholder="t0 = {$t0}，十六进制 {$t0:x}；填写后只记录不暂停"></label>
      <p class="muted">命中次数按从 S0 起这条指令的执行次数计算；回退后随历史变化。日志断点的输出在底部“日志”。</p>
      <p><button class="primary">保存</button> <button type="button" id="bp-remove">删除断点</button></p>
    </form>`,
  );
  $("bp-form").onsubmit = (e) => {
    e.preventDefault();
    Object.assign(b, {
      enabled: $("bp-enabled").checked,
      condition: $("bp-condition").value.trim(),
      hit: Math.max(0, Number($("bp-hit").value) || 0),
      log: $("bp-log").value.trim(),
    });
    if (!breakpoints.includes(b)) breakpoints.push(b);
    $("modal").close();
    breakpointChanged();
  };
  $("bp-remove").onclick = () => {
    breakpoints = breakpoints.filter((x) => x !== b);
    $("modal").close();
    breakpointChanged();
  };
  $("bp-condition").focus();
}
function toggleBreakpoint(line, conditional = false) {
  const at = breakableAddress(line);
  if (!at) {
    notify(
      dirty
        ? "代码改过了，先汇编再设断点。"
        : "这一行没有可执行的指令（空行、注释或数据），断点要设在有指令的行。",
      { transient: true },
    );
    return;
  }
  if (at.label)
    notify(`断点设在这个标签下面的第一条指令（第 ${at.line} 行）。`, {
      transient: true,
    });
  toggleAddressBreakpoint(at.address, conditional);
}
function appendLogs(logs = []) {
  if (!logs.length) return;
  debugLog.push(...logs);
  if (debugLog.length > 500) debugLog.splice(0, debugLog.length - 500);
  if (bottom !== "logs") $("logs-tab").classList.add("unread");
}
function renderLogs() {
  $("logs").innerHTML = debugLog.length
    ? debugLog
        .map(
          (l) =>
            `<button class="trace-row" data-log-step="${l.step}"><small>#${l.step} · ${hex(l.address)}</small> ${esc(l.text)}</button>`,
        )
        .join("")
    : '<p class="muted">日志断点（断点 ✎ 中填写“日志消息”）命中时在这里记录，不暂停程序。</p>';
  $("logs")
    .querySelectorAll("[data-log-step]")
    .forEach(
      (b) =>
        (b.onclick = () =>
          command("seek", { step: Number(b.dataset.logStep) }).then(followPC)),
    );
}
// Program output with each consumed input echoed where the program read it.
function renderOutput() {
  let html = "",
    from = 0;
  for (const e of state.inputEchoes || []) {
    html +=
      esc(state.output.slice(from, e.at)) +
      `<span class="echo" title="你输入的内容">${esc(e.text)}</span>\n`;
    from = e.at;
  }
  $("output").innerHTML = html + esc(state.output.slice(from));
  $("output").scrollTop = $("output").scrollHeight;
}
function renderStops() {
  $("breakpoints").innerHTML = breakpoints
    .map((b, i) => {
      const details = [
        b.condition && "条件 " + b.condition,
        b.hit && `第 ${b.hit} 次`,
        b.log && "日志 " + b.log,
      ].filter(Boolean);
      return `<div class="bp-row ${b.enabled ? "" : "off"}">
        <input type="checkbox" data-bp-enable="${i}" ${b.enabled ? "checked" : ""} aria-label="启用 ${esc(b.file)}:${b.line}">
        <button class="bp" data-bp="${i}">${breakpointGlyph(b)} ${esc(b.file)}:${b.line}<br><small>${esc(details.join(" · ") || hex(b.address))}</small></button>
        <button data-bp-edit="${i}" aria-label="编辑断点" title="编辑断点">✎</button><button data-bp-remove="${i}" aria-label="删除断点" title="删除断点">×</button>
      </div>`;
    })
    .join("");
  $("breakpoints")
    .querySelectorAll("[data-bp]")
    .forEach(
      (b) =>
        (b.onclick = () => {
          let bp = breakpoints[Number(b.dataset.bp)];
          gotoSource(bp.file, bp.line);
        }),
    );
  $("breakpoints")
    .querySelectorAll("[data-bp-enable]")
    .forEach(
      (c) =>
        (c.onchange = () => {
          breakpoints[Number(c.dataset.bpEnable)].enabled = c.checked;
          breakpointChanged();
        }),
    );
  $("breakpoints")
    .querySelectorAll("[data-bp-edit]")
    .forEach(
      (b) =>
        (b.onclick = () =>
          editBreakpoint(breakpoints[Number(b.dataset.bpEdit)].address)),
    );
  $("breakpoints")
    .querySelectorAll("[data-bp-remove]")
    .forEach(
      (b) =>
        (b.onclick = () => {
          breakpoints.splice(Number(b.dataset.bpRemove), 1);
          breakpointChanged();
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
// Pausing only asks the run loop to stop: the request in flight finishes and
// the loop exits before anything else may command the machine. Until then
// the UI keeps saying "running" (2026-10-22 trial: commands were dropped and a
// late follow switched files when this flag was cleared early).
let stopRequested = false,
  runDone = Promise.resolve();
function requestStop() {
  if (running) {
    stopRequested = true;
    updateControls();
  }
  return runDone;
}
async function run(mode = "run", extra = {}) {
  if (busy || dirty || running) return;
  running = true;
  stopRequested = false;
  let finish;
  runDone = new Promise((resolve) => (finish = resolve));
  try {
    await runLoop(mode, extra);
  } finally {
    running = false;
    stopRequested = false;
    updateControls();
    finish();
  }
  arrive(mode !== "source");
  lens.settle();
}
async function runLoop(mode, extra) {
  updateControls();
  let first = true;
  // F5 runs at full speed like VS Code; "演示" steps one instruction at a time
  // and follows the PC so a class can watch (decided after the 2026-10-22 trial).
  const demonstrate = mode === "demo";
  if (demonstrate) mode = "run";
  pendingResume = null;
  while (!stopRequested) {
    let s = await command(mode, {
      limit:
        mode === "run"
          ? demonstrate
            ? 1
            : 150
          : mode === "over" || mode === "out"
            ? 100000
            : 1000,
      breakpoints: activeBreakpoints(),
      watches,
      skipBreakpoint: first,
      ...extra,
    });
    first = false;
    // Demonstration pace: one instruction at a time so the PC can be followed.
    // Step-by-step narration lives in focus mode (DESIGN §3.8).
    if (demonstrate && s?.last) {
      followPC();
      await new Promise((resolve) =>
        setTimeout(resolve, Number($("demo-speed").value)),
      );
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
  // An input wait interrupts the action; submitting input repeats it (§ trial A4).
  if (state?.status === "waiting")
    pendingResume = { mode: demonstrate ? "demo" : mode, extra };
  followPC();
}
let pendingResume = null;
async function submitInput(value) {
  await command("input", { value });
  const resume = pendingResume;
  pendingResume = null;
  if (!resume || state?.status !== "paused") return;
  if (resume.mode === "step") await command("step").then(followPC);
  else await run(resume.mode, resume.extra);
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
function commandList() {
  const commands = [
    ["汇编工程", assemble, "assemble"],
    ["快速打开文件／标签／地址", () => openPicker(""), "quickOpen"],
    ["转到当前文件中的符号", () => openPicker("@"), "outline"],
    ["专注模式", () => openFocus(), "focus"],
    ["机器单步", () => command("step").then(followPC), "step"],
    ["源码单步", () => run("source"), "source"],
    ["跨过调用", () => run("over"), "over"],
    ["跳出函数", () => run("out"), "out"],
    ["回退一步", () => command("back").then(followPC), "back"],
    ["运行／继续", () => run(), "run"],
    ["演示播放（逐条执行并跟随）", () => run("demo")],
    ["重新汇编并重启", () => assemble(), "restart"],
    ["暂停", () => requestStop(), "pause"],
    ["停止并回到起点", () => actions.stop(), "stop"],
    ["切换断点（光标行）", () => actions.breakpoint(), "breakpoint"],
    [
      "运行到光标",
      () => {
        let address = lineAddress(
          editor.state.doc.lineAt(editor.state.selection.main.head).number,
        );
        if (address != null)
          run("run", {
            breakpoints: [...activeBreakpoints(), { address }],
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
  return commands.map(([label, run, action]) => ({
    label,
    run,
    keys: action && keys.find(action) ? keyLabel(keys.find(action), mac) : "",
  }));
}
function openCommands() {
  openPicker(">");
}
// One picker for files, labels, lines, addresses and commands (VS Code's
// quick open with its > @ : prefixes).
function openPicker(prefix = "") {
  const commands = commandList();
  modal(
    prefix === ">" ? "命令面板" : "快速打开",
    `<input id="picker-input" aria-label="搜索" autocomplete="off" style="width:100%"><div id="picker-list" role="listbox"></div><p class="muted picker-help">文件或标签名 · @ 当前文件符号 · :行号 · 文件:行号 · 0x 地址 · > 命令</p>`,
  );
  const input = $("picker-input");
  input.value = prefix;
  let items = [],
    selected = 0;
  const choose = (x) => {
    if (!x) return;
    $("modal").close();
    if (x.kind === "command") commands[x.index].run();
    else if (x.kind === "file") {
      gotoSource(x.file, 1);
    } else if (x.kind === "symbol" || x.kind === "line")
      gotoSource(x.file, x.line);
    else if (x.kind === "address") {
      if (program.instructions.some((i) => i.address === x.address))
        gotoAddress(x.address);
      else memoryAt(x.address);
    }
  };
  const render = () => {
    items = quickOpenItems(input.value, {
      files,
      symbols: program.symbols,
      activeFile,
      commands,
    });
    selected = Math.max(0, Math.min(selected, items.length - 1));
    $("picker-list").innerHTML =
      items
        .map(
          (x, i) =>
            `<button class="command-item ${i === selected ? "selected" : ""}" role="option" aria-selected="${i === selected}" data-pick="${i}">${esc(x.label)}${x.detail ? `<kbd>${esc(x.detail)}</kbd>` : ""}</button>`,
        )
        .join("") || '<p class="muted">没有匹配项</p>';
    $("picker-list")
      .querySelectorAll("[data-pick]")
      .forEach(
        (b) => (b.onclick = () => choose(items[Number(b.dataset.pick)])),
      );
    $("picker-list")
      .querySelector(".selected")
      ?.scrollIntoView({ block: "nearest" });
  };
  input.oninput = () => {
    selected = 0;
    render();
  };
  input.onkeydown = (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      selected += e.key === "ArrowDown" ? 1 : -1;
      render();
    } else if (e.key === "Enter") {
      e.preventDefault();
      choose(items[selected]);
    }
  };
  render();
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
}
$("assemble").onclick = assemble;
$("step").onclick = () =>
  command("step").then((s) => {
    pendingResume = s?.status === "waiting" ? { mode: "step" } : null;
    followPC();
    arrive();
  });
$("demo").onclick = () => run("demo");
$("back").onclick = () =>
  command("back").then(() => {
    followPC();
    arrive();
  });
for (let mode of ["source", "over", "out", "run"])
  $(mode).onclick = () => run(mode);
$("pause").onclick = () => requestStop();
$("commands").onclick = openCommands;
$("radix").innerHTML = RADIXES.map(
  ([value, label]) =>
    `<option value="${value}" title="${esc(RADIX_HELP[value])}" ${value === radix ? "selected" : ""}>${label}</option>`,
).join("");
// What the notations mean, plus a character table to look 104 → h up in.
$("radix-help").onclick = () => {
  const cell = (b) =>
    `<td><code>${b}</code></td><td><code>0x${b.toString(16).padStart(2, "0")}</code></td><td><b>${esc(escapeByte(b) === " " ? "空格" : escapeByte(b))}</b></td>`;
  const codes = [0, 9, 10, ...Array.from({ length: 95 }, (_, i) => 32 + i)];
  const rows = [];
  for (let i = 0; i < codes.length; i += 4)
    rows.push(
      `<tr>${codes
        .slice(i, i + 4)
        .map(cell)
        .join("")}</tr>`,
    );
  modal(
    "数值显示",
    `<div class="radix-help">${RADIXES.map(([v, l]) => `<p><b>${l}</b> ${esc(RADIX_HELP[v].replace(/^[^：]+：/, ""))}</p>`).join("")}
     <p class="muted">只改变只读区域（寄存器、内存、地址、执行结果、专注模式）的显示，代码不会变。</p>
     <h4>字符编码表（ASCII）</h4>
     <p class="muted">内存里存的都是数字；按这张表，每个 0–127 的数可以读成一个字符。表中列出十进制、十六进制和对应的字符。</p>
     <table class="ascii-table"><tbody>${rows.join("")}</tbody></table></div>`,
  );
};
$("radix").onchange = () => {
  radix = $("radix").value;
  try {
    localStorage.setItem("radix", radix);
  } catch {}
  render();
  lens.update(dirty ? null : state);
};
function openFocus() {
  if (dirty || !state || state.status === "empty")
    return notify("请先汇编，再进入专注模式");
  lens.open();
}
$("focus-open").onclick = openFocus;
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
  await submitInput(value);
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
// Global shortcuts (DESIGN §3.9). Focus mode handles its own arrow keys first.
const mac = /Mac|iPhone|iPad/.test(navigator.platform);
const keys = new Keymap(mac);
function hintOnce(key, text) {
  try {
    if (localStorage.getItem("key-hint:" + key)) return;
    localStorage.setItem("key-hint:" + key, "1");
  } catch {}
  notify(text);
}
const actions = {
  run: () => !running && $("run").click(),
  pause: () => running && $("pause").click(),
  stop: async () => {
    await requestStop();
    if (state?.step) await command("seek", { step: 0 });
    followPC();
    arrive(true);
  },
  restart: () => assemble(),
  over: () => $("over").click(),
  source: () => $("source").click(),
  step: () => $("step").click(),
  out: () => $("out").click(),
  back: () => $("back").click(),
  breakpoint: () => {
    if (view !== "source") return;
    toggleBreakpoint(
      editor.state.doc.lineAt(editor.state.selection.main.head).number,
    );
  },
  assemble: () => assemble(),
  quickOpen: () => openPicker(""),
  outline: () => openPicker("@"),
  commands: () => openCommands(),
  focus: () => openFocus(),
  navBack: () => navigate(-1),
  navForward: () => navigate(1),
};
document.addEventListener("keydown", (e) => {
  const r = keys.handle(e);
  if (r.pending) {
    e.preventDefault();
    notify(`已按下 ${keyLabel("Mod+K", mac)}，等待第二个键…`);
    setTimeout(() => {
      const t = keys.expire();
      if (t.hint) hintOnce(t.retiredKey, t.hint);
      else if ($("banner").textContent.startsWith("已按下")) notify("");
    }, 1600);
    return;
  }
  const typing = e.target.closest?.("input, textarea, .cm-editor");
  // Alt+Left still moves by word inside text on macOS; only explain it elsewhere.
  if (r.hint && !(typing && r.retiredKey === "Alt+ArrowLeft"))
    hintOnce(r.retiredKey, r.hint);
  else if ($("banner").textContent.startsWith("已按下")) notify("");
  if (!r.action) return;
  // Inside text fields only global, non-character commands apply.
  if (
    typing &&
    ["navBack", "navForward"].includes(r.action) &&
    e.target.closest("input, textarea")
  )
    return;
  e.preventDefault();
  actions[r.action]();
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
