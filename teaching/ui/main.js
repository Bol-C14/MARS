import {
  EditorView,
  Decoration,
  ViewPlugin,
  GutterMarker,
  WidgetType,
  gutter,
  keymap,
} from "@codemirror/view";
import { EditorState, StateEffect, StateField, Compartment } from "@codemirror/state";
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
  withOperands,
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
import {
  lineDecision,
  beatModel,
  lineSummary,
  genericTemplate,
} from "./beats.js";
import { serviceAt, serviceGuide, syscallDetail } from "./syscalls.js";
import { directiveGuide, instructionIndex, searchInstructions, usageOf } from "./instruction-index.js";
import { Tutorial } from "./tutorial.js";
import { supportsBits } from "./bits.js";
import { projectManager } from "./project-manager.js";
import { assemblyScope, scopeHints } from "./workspace.js";
const $ = (id) => document.getElementById(id);
// Jumps and branches take VS Code's control-keyword colour, the same purple
// as control-flow arrows.
const CONTROL_OPS =
  /^(?:j|jal|jr|jalr|b|beq|bne|bgez|bgtz|blez|bltz|bgezal|bltzal|blt|bgt|ble|bge|bltu|bgtu|bleu|bgeu|beqz|bnez)$/;
// A Chinese description of an instruction: the hand-written explanation,
// else the purpose and limits from the instruction search table, and only
// then MARS's English text (round-4 trial: sub showed "Subtraction with
// overflow"). One table serves search, hover and the inspector.
const CURATED = new Map(
  instructionIndex({})
    .filter((x) => x.kind === "instruction")
    .map((x) => [x.op, x]),
);
function zhDoc(op) {
  if (explanations[op]) return explanations[op];
  const c = CURATED.get(op);
  return c ? `${c.purpose}${c.note ? "；" + c.note : ""}。` : "";
}
// How an instruction is written, for the hover note and the inspector.
function usage(op, source = "") {
  const c = CURATED.get(op);
  if (c) return usageOf(c, source);
  const example = program.instructionDocs[op]?.example;
  return example ? { format: example, example, parts: [] } : null;
}
let workspace = null;
// Four different things (P0): the tab being edited (activeFile), the scope
// the next assembly would use (nextScope: auto, single or manual), the way
// saved with the project (workspace.assembly), and the target: the files and entry of the
// program that is loaded now. Execution only runs while the target is still
// what the student is looking at.
let target = null,
  lastInTarget = "",
  tutorial = null,
  problemsShownForError = false;
const fileAccess = new Compartment();
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
  inspectingPlace = null,
  following = true,
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
      "break-dot" +
      (this.breakpoint && !this.breakpoint.enabled ? " off" : "") +
      (this.breakpoint && this.breakpoint.address == null ? " stale" : "");
    e.textContent = breakpointGlyph(this.breakpoint);
    if (this.breakpoint && this.breakpoint.address == null)
      e.title = "这个文件没有参与当前汇编，断点暂不生效";
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
// recently executed line wrote, as of the selected history state. A pseudo
// line shows only its result: $at is the assembler's scratch register, so it
// is left out when the line writes anything else (2026-10-23 feedback: la
// showed $at first, then $a0, as if it took two steps). A line that branches
// or calls a service shows the decision instead (lineDecision).
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
    runs = new Map(),
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
    runs.set(line, [events[i], ...(runs.get(line) || [])]);
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
  // A pseudo line stopped halfway (machine step) has only its scratch value.
  const next = program.instructions.find((i) => i.address === state?.pc),
    latest = events.at(-1);
  const midLine =
    next &&
    latest &&
    next.file === latest.instruction.file &&
    next.line === latest.instruction.line &&
    next.address === latest.pc + 4
      ? next.file + ":" + next.line
      : null;
  for (const [line, writes] of map) {
    const decision = lineDecision(runs.get(line), {
      symbols: program.symbols,
      instructions: program.instructions,
      format: (v, name) => fmt(v, 4, name ? regKind(name) : "value").text,
    });
    if (decision) {
      map.set(line, decision);
      continue;
    }
    if (writes.size > 1 || line === midLine) writes.delete("$at");
    if (writes.size)
      map.set(
        line,
        [...writes]
          .reverse()
          .map(([n, v]) => `${n} = ${v}`)
          .join("  "),
      );
    else map.delete(line);
  }
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
      this.text.length > 64 ? this.text.slice(0, 63) + "…" : this.text;
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
          // Strings and comments first: a # inside a string is text, and
          // words inside a string are not instructions.
          let text = l.text,
            strings = [],
            comment = -1;
          for (let i = 0, quote = null; i < text.length; i++) {
            const c = text[i];
            if (quote) {
              if (c === "\\") i++;
              else if (c === quote) {
                strings.at(-1)[1] = i + 1;
                quote = null;
              }
            } else if (c === '"' || c === "'") {
              quote = c;
              strings.push([i, text.length]);
            } else if (c === "#") {
              comment = i;
              break;
            }
          }
          const code = comment < 0 ? text : text.slice(0, comment),
            inString = (k) => strings.some(([a, b]) => k >= a && k < b);
          for (const [a, b] of strings)
            ranges.push(
              Decoration.mark({ class: "cm-string" }).range(l.from + a, l.from + b),
            );
          for (let m of code.matchAll(
            /\$\w+|\b0x[\da-fA-F]+\b|\b\d+\b|\b[a-zA-Z_]\w*:?/g,
          )) {
            if (inString(m.index)) continue;
            let type = m[0].startsWith("$")
              ? "reg"
              : m[0].endsWith(":")
                ? "label"
                : /^\d/.test(m[0])
                  ? "number"
                  : program.instructionDocs[m[0]] || zhDoc(m[0])
                    ? CONTROL_OPS.test(m[0])
                      ? "op cm-control"
                      : "op"
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
    canRun =
      !dirty && !blocked() && ["paused", "waiting"].includes(state?.status);
  editor.dispatch({ selection: { anchor: pos } });
  const items = [
    [
      "运行到此行",
      canRun && address != null,
      () => run("run", { breakpoints: [...activeBreakpoints(), { address }] }),
    ],
    ["切换断点", address != null, () => toggleBreakpoint(line), "breakpoint"],
    ["编辑断点…", address != null, () => editBreakpoint(address)],
    ["转到定义／说明", true, () => openDetail(pos)],
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
      fileAccess.of([EditorState.readOnly.of(false), EditorView.editable.of(true)]),
      decorations,
      peekField,
      breakpointGutter,
      autocompletion({ override: [completion] }),
      keymap.of([
        {
          key: "F12",
          run: () => {
            openDetail(editor.state.selection.main.head);
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
          if (!activeFile) return;
          files[activeFile] = u.state.doc.toString();
          workspace?.changed();
          renderTabs();
          // Editing another exercise leaves the loaded program valid (P0).
          if (!target || target.files.includes(activeFile)) {
            dirty = true;
            $("banner").textContent =
              "源码已修改 · 重新汇编后继续执行；旧轨迹属于上一版本";
            $("banner").className = "visible";
          }
          updateControls();
        }
        overlay?.schedule();
      }),
      EditorView.domEventHandlers({
        mousemove: (e) => hover(e),
        mouseleave: () => hideTooltip(),
        // Touch has no hover: a tap shows the same note, with its button.
        pointerdown: (e) => {
          if (e.pointerType === "touch") {
            tipFor = "";
            hover(e);
          }
        },
        click: (e) => {
          if (e.metaKey || e.ctrlKey) openDetailAt(e);
        },
        contextmenu: (e) => {
          let pos = editor.posAtCoords({ x: e.clientX, y: e.clientY });
          if (pos == null) return false;
          e.preventDefault();
          // On macOS Ctrl+click arrives here and never as a click (classroom
          // 2026-10-31: the detail "did nothing" for students using Ctrl).
          if (e.ctrlKey && IS_MAC) {
            openDetailAt(e);
            return true;
          }
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
  getState: () => (dirty || blocked() ? null : state),
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
    tutorial?.update();
  },
});
// Lookahead is only computed while the lens shows it (DESIGN §4).
const lookahead = () =>
  lens.isOpen ? { lookahead: lens.lookaheadLines() } : {};
// Where a line's code stops: comments and text in quotes hold no tokens.
function quotedOrComment(text, col) {
  let quote = "";
  for (let i = 0; i < col; i++) {
    if (quote) {
      if (text[i] === "\\") i++;
      else if (text[i] === quote) quote = "";
    } else if (text[i] === '"' || text[i] === "'") quote = text[i];
    else if (text[i] === "#") return true;
  }
  return !!quote;
}
function tokenAt(pos) {
  let l = editor.state.doc.lineAt(pos),
    col = pos - l.from;
  if (quotedOrComment(l.text, col)) return "";
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
// The syscall on a source line: which service (from before the call, never
// the $v0 a read has overwritten), where that number came from, and the
// values its parameters had or have.
function syscallAt(place) {
  const p = state?.preview?.instruction;
  const next =
    !dirty &&
    p?.op === "syscall" &&
    (!place || (p.file === place.file && p.line === place.line));
  const event =
    !next && !dirty && place
      ? [...(state?.trace || [])]
          .reverse()
          .find(
            (e) =>
              e.step <= state.step &&
              e.instruction.op === "syscall" &&
              e.instruction.file === place.file &&
              e.instruction.line === place.line,
          )
      : null;
  const { n, from, setter } = serviceAt({
    next,
    event,
    v0: regValue("$v0"),
    lines: place ? (files[place.file] || "").split("\n") : [],
    line: place?.line || 0,
  });
  const values = {};
  for (const [r] of serviceGuide[n]?.[2] || [])
    values[r] = next
      ? regValue(r)
      : (event?.accesses.find(
          (a) => a.kind === "register" && !a.write && a.name === r,
        )?.value ?? null);
  // The step that put the value into $v0, when the recorded history has it.
  const before = next ? state.step : event ? event.step - 1 : null;
  const writer =
    setter && before != null
      ? [...(state?.trace || [])]
          .reverse()
          .find(
            (e) =>
              e.step <= before &&
              e.instruction.file === place?.file &&
              e.instruction.line === setter.line &&
              e.accesses.some((a) => a.write && a.name === "$v0"),
          )
      : null;
  return {
    n,
    from,
    setter,
    step: writer?.step ?? null,
    values,
    event,
    waiting: next && state.status === "waiting",
    esc,
    show: (v, r) => fmt(v, 4, r ? regKind(r) : "value").text,
  };
}
const tipUsage = (op) => {
  const u = usage(op);
  return u ? `<p class="tip-formula">写法：<code>${esc(u.format)}</code></p>` : "";
};
const isNumber = (token) => /^-?(?:0x[\da-f]+|\d+)$/i.test(token);
function summary(token, line = "", place = null) {
  token = canonicalReg(token);
  if (token.startsWith("$"))
    return `<b>${esc(token)}</b> ${esc(fmt(regValue(token), 4, regKind(token)).text)}<p>${esc(role(token))}</p><small>执行 ${state?.step ?? 0} 步后的值</small>`;
  if (token === "syscall") {
    const at = syscallAt(place),
      g = serviceGuide[at.n];
    return `<b>${esc(at.n == null ? "syscall（$v0 未知）" : `syscall：${g ? g[0] : "不支持"}（$v0 = ${at.n}）`)}</b><p>${esc(g ? g[1] : "syscall 做什么由 $v0 里的数决定；要执行到这一行才知道。")}</p>${at.setter ? `<small>第 ${at.setter.line} 行 ${esc(at.setter.text)} 放入</small>` : ""}`;
  }
  if (zhDoc(token)) {
    const text = zhDoc(token);
    return `<b>${esc(token)}</b><p>${esc(text)}</p>${tipUsage(token)}${lineFormula(place)}<small>指令／汇编器说明</small>`;
  }
  if (directiveGuide[token])
    return `<b>${esc(token)}</b><p>${esc(directiveGuide[token][1])}</p><p class="tip-formula">写法：<code>${esc(directiveGuide[token][0])}</code></p><small>汇编器指示，不是机器指令</small>`;
  if (isNumber(token)) return `<b>${esc(token)}</b><p>写在代码里的常数</p>`;
  if (program.instructionDocs[token]) {
    const doc = program.instructionDocs[token],
      mars = withOperands(doc.description, doc.example, line);
    return `<b>${esc(token)}</b><p>${esc(mars.text)}</p>${lineFormula(place)}<small>MARS 原文${mars.substituted ? "（已代入本行的操作数）" : `（示例：${esc(doc.example)}）`}</small>`;
  }
  let symbol = program.symbols.find((s) => s.name === token);
  if (symbol)
    return `<b>${esc(token)}</b><p>符号地址 ${hex(symbol.address)}</p><small>${DETAIL_KEYS}跳转定义</small>`;
  return `<b>${esc(token)}</b><p>标签或名称；汇编后可查看地址</p>`;
}
// Term definitions under a tooltip (it moves with the pointer, so its words
// cannot be hovered themselves).
function definitions(text) {
  const terms = termsIn(text);
  return terms.length
    ? `<dl class="defs">${terms.map(([t, d]) => `<dt>${esc(t)}</dt><dd>${esc(d)}</dd>`).join("")}</dl>`
    : "";
}
// Hover gives the brief; the details live in the inspector (classroom
// 2026-10-24: the detailed view was hard to find and the hover too full).
// The note stays put while the pointer is on the same word and can be
// entered, so its “查看详细” is clickable without knowing the shortcut.
const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform);
const DETAIL_KEYS = IS_MAC ? "⌘ 或 Ctrl＋点击" : "Ctrl＋点击";
const DETAIL_HINT = `${DETAIL_KEYS}：详情在右侧“详细检查”`;
let tipFor = "",
  tipHide = null;
function hideTooltip(delay = 300) {
  clearTimeout(tipHide);
  tipHide = setTimeout(() => {
    $("tooltip").hidden = true;
    tipFor = "";
  }, delay);
}
// Past the end of a line the editor reports the line's end, which is not the
// last word: clicking the blank there must not open that word.
function pointedPos(e) {
  const pos = editor.posAtCoords({ x: e.clientX, y: e.clientY });
  if (pos == null) return null;
  const end = editor.state.doc.lineAt(pos).to,
    right = editor.coordsAtPos(end)?.right;
  return { pos, past: pos === end && right != null && e.clientX > right + 4 };
}
function hover(e) {
  const at = pointedPos(e),
    pos = at?.pos,
    token = !at || at.past ? "" : tokenAt(pos);
  if (!token) return hideTooltip();
  const line = editor.state.doc.lineAt(pos),
    place = { file: activeFile, line: line.number },
    key = `${token}@${activeFile}:${line.number}`;
  clearTimeout(tipHide);
  if (key === tipFor && !$("tooltip").hidden) return;
  tipFor = key;
  $("tooltip").innerHTML = `<div class="tip-hint">${DETAIL_HINT}</div>${summary(token, line.text, place)}<button class="tip-detail" type="button">在右侧查看详细 →</button>`;
  $("tooltip").querySelector(".tip-detail").onclick = () => {
    inspectToken(token, place);
    hideTooltip(0);
  };
  // A register may hold an address: follow it from here too (round-4 trial).
  const reg = canonicalReg(token);
  if (reg.startsWith("$") && state) {
    const go = document.createElement("button");
    go.className = "tip-detail";
    go.type = "button";
    go.textContent = "作为地址查看";
    go.onclick = () => {
      memoryAt(regValue(reg));
      hideTooltip(0);
    };
    $("tooltip").append(" ", go);
  }
  $("tooltip").hidden = false;
  $("tooltip").style.left = Math.min(e.clientX + 12, innerWidth - 380) + "px";
  $("tooltip").style.top = Math.min(e.clientY + 14, innerHeight - 220) + "px";
}
// The word under the pointer or cursor; on a blank or a comment, the line's
// instruction. Every way of asking for details ends up here, so a request
// always answers: with the details or with the reason there are none.
function openDetail(pos, past = false) {
  const line = editor.state.doc.lineAt(pos),
    place = { file: activeFile, line: line.number };
  const word = line.text
    .replace(/#.*/, "")
    .replace(/^\s*(?:[\w.$]+:\s*)*/, "")
    .trim()
    .split(/\s+/)[0];
  const token = (past ? "" : tokenAt(pos)) || word;
  if (!token) return notify("这一行没有指令可以查看。", { transient: true });
  inspectToken(token, place);
}
function openDetailAt(e) {
  const at = pointedPos(e);
  if (at) openDetail(at.pos, at.past);
}
// Details open in a panel away from the pointer: open it if it was folded,
// start at the top, and draw the eye to it even if its content stays the same.
function revealContext() {
  if ($("panel-context").classList.contains("collapsed")) setPanel("context", false);
  const panel = $("panel-context");
  panel.classList.remove("attention");
  void panel.offsetWidth;
  panel.classList.add("attention");
  $("context").scrollTop = 0;
  clearTimeout(revealContext.timer);
  revealContext.timer = setTimeout(() => panel.classList.remove("attention"), 1600);
}
$("tooltip").addEventListener("mouseenter", () => clearTimeout(tipHide));
$("tooltip").addEventListener("mouseleave", () => hideTooltip());
const CONTEXT_HINT = `<p class="muted">还没有固定检查对象。悬停代码看简短说明；${DETAIL_KEYS}、点浮窗里的“查看详细”或按 F12，在这里查看完整说明。</p>`;
// The inspector follows execution by default, showing the line that just
// ran (or, before anything ran, the next one as a preview); opening an object
// pins it until "回到跟随执行" or "取消固定" (round-4 trial: a pinned syscall
// from line 36 was read as describing the current line 11).
function followInspector() {
  if (!following || !state || dirty || running) return;
  const e = state.last?.instruction ? state.last : state.preview,
    ins = e?.instruction;
  if (!ins) return showContext(CONTEXT_HINT);
  const word = ((files[ins.file] || "").split("\n")[ins.line - 1] || "")
    .replace(/#.*/, "")
    .replace(/^\s*(?:[\w.$]+:\s*)*/, "")
    .trim()
    .split(/\s+/)[0];
  const token =
    ins.op === "syscall" ? "syscall" : isInstruction(word) ? word : ins.op;
  inspectToken(token, { file: ins.file, line: ins.line }, { refresh: true });
}
function modeBar() {
  if (!state || dirty) return "";
  const at = (e) => e?.instruction && `${e.instruction.file}:${e.instruction.line}`;
  if (following) {
    const e = state.last?.instruction ? state.last : state.preview;
    return e?.instruction
      ? `<div class="inspect-mode">跟随执行 · ${state.last?.instruction ? "刚执行" : "即将执行"}的第 ${e.instruction.line} 行</div>`
      : "";
  }
  if (!inspecting) return "";
  const pinned = inspectingPlace ? `${inspectingPlace.file}:${inspectingPlace.line}` : "";
  const here = program.instructions.find((i) => i.address === executionPC());
  const away =
    pinned && here && ![at(state.last), at(state.preview)].includes(pinned);
  return `<div class="inspect-mode pinned">已固定 · ${esc(inspecting)}${inspectingPlace ? ` · 第 ${inspectingPlace.line} 行` : ""}${away ? ` · 执行已到第 ${here.line} 行` : ""}<button id="follow-again">回到跟随执行</button></div>`;
}
function showContext(html) {
  $("context").innerHTML = modeBar() + html;
  $("clear-focus").hidden = following || !inspecting;
  if ($("follow-again"))
    $("follow-again").onclick = () => $("clear-focus").click();
  setTimeout(() => tutorial?.update());
}
function inspectToken(token, place = null, { refresh = false } = {}) {
  if (!token) return;
  // Opening an object pins it; refreshing or following keeps the mode.
  if (!refresh) following = false;
  inspecting = token;
  inspectingPlace = place;
  if (!refresh) {
    $("tooltip").hidden = true;
    revealContext();
  }
  let address = token.match(/^(-?(?:0x[\da-fA-F]+|\d+))?\((\$\w+)\)$/);
  if (address) {
    let base = regValue(address[2]),
      offset = Number(address[1] || 0),
      effective = (base + offset) | 0;
    showContext(
      `<h3>${esc(token)}</h3><p>按执行 ${state?.step ?? 0} 步后的寄存器值算出的地址</p><div class="values"><span>基址</span><span>${esc(address[2])} = ${hex(base)}</span><span>偏移</span><span>${offset} 字节</span><span>地址</span><span>${hex(effective)}</span></div><button id="inspect-memory">查看内存 →</button>`,
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
      `<h3>${esc(token)} <small class="muted">寄存器</small></h3><p>${esc(role(token))}</p>${valueHTML(value)}<p class="muted">执行 ${state?.step ?? 0} 步后的值 · ${last ? `最后一次写入在第 ${last} 步` : "还没有被写入过（初始值）"}</p><div class="context-actions"><button id="refs">查找引用</button><button id="pin">${pinned.has(token) ? "取消固定" : "固定"}</button><button id="point">作为地址查看</button><button id="last-write" ${last ? "" : "disabled"}>最后写入</button><button id="next-write">运行到下次写入</button></div>`,
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
    const at = syscallAt(place),
      detail = syscallDetail({ ...at, regTitle: (r) => r + "：" + role(r) }),
      words = (serviceGuide[at.n] || []).flat(2).join(" ") + " 寄存器 syscall";
    showContext(
      `<h3>${esc(detail.title)}</h3>${detail.html}${termsIn(words).length ? `<details class="detail-terms"><summary>术语</summary>${definitions(words)}</details>` : ""}<div class="context-actions">${at.n === 11 || at.n === 12 ? '<button id="char-table">查看字符编码表</button>' : ""}<button id="service-list">$v0 的值对应做什么</button></div>`,
    );
    if ($("char-table")) $("char-table").onclick = () => $("radix-help").click();
    $("service-list").onclick = () =>
      modal(
        "syscall：$v0 选定做什么",
        Object.entries(services)
          .map(
            ([id, s]) =>
              `<p><b>$v0 = ${id}</b> ${serviceGuide[id]?.[0] || s[0]} · ${serviceGuide[id]?.[1] || ""} <small class="muted">参数 ${s[1].join(", ") || "无"} → ${s[2].join(", ") || "无返回值"}</small></p>`,
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
  if (isInstruction(token) && place) return instructionDetail(token, place);
  if (directiveGuide[token]) {
    const [written, does] = directiveGuide[token];
    showContext(
      `<h3>${esc(token)} <small class="muted">汇编器指示</small></h3><p>${esc(does)}</p><dl class="detail-steps"><dt>写法</dt><dd><code>${esc(written)}</code></dd></dl><p class="muted">它告诉汇编器怎么安排内容，本身不是一条机器指令，不会单独执行。</p>`,
    );
    return;
  }
  if (isNumber(token)) {
    showContext(`<h3>${esc(token)} <small class="muted">常数</small></h3><p>写在代码里的数，同一个值的几种写法：</p>${valueHTML(Number(token))}`);
    return;
  }
  const known = zhDoc(token) || program.instructionDocs[token]?.description,
    u = isInstruction(token) ? usage(token) : null;
  showContext(
    `<h3>${esc(token)}</h3><p>${esc(known || "标签或名称。汇编后可以查看它的地址；也可以查找代码里哪些地方用到它。")}</p>${u ? usageRows(u) : ""}<div class="context-actions"><button id="refs">查找引用</button></div>`,
  );
  $("refs").onclick = () => showReferences(token);
}
// Which line a label is on, when the loaded program knows it.
function labelLine(name) {
  const symbol = program.symbols.find((s) => s.name === name),
    ins = symbol && program.instructions.find((i) => i.address === symbol.address);
  return ins?.line;
}
// The written form with each part's meaning and, for a line, what it wrote.
function usageRows(u) {
  const part = (p) => {
    const line = p.name === "label" && p.value ? labelLine(p.value) : null;
    return `<li><code>${esc(p.name)}</code>${p.value ? ` = <code>${esc(p.value)}</code>` : ""} ${esc(line ? p.meaning.replace(/（.*）$/, "") : p.meaning)}${line ? `<small>（第 ${line} 行）</small>` : ""}</li>`;
  };
  const written = u.parts.some((p) => p.value);
  return `<dl class="detail-steps"><dt>写法</dt><dd><code>${esc(u.format)}</code>${u.parts.length ? `<ul class="usage-parts">${u.parts.map(part).join("")}</ul>` : ""}</dd>${u.formula ? `<dt>通用规则</dt><dd><code>${esc(u.formula)}</code></dd>` : ""}${!written && u.example && u.example !== u.format ? `<dt>例子</dt><dd><code>${esc(u.example)}</code></dd>` : ""}</dl>`;
}
const isInstruction = (token) =>
  !!(zhDoc(token) || program.instructionDocs[token]);
// The run of a source line the inspector explains: the line that just ran,
// the line about to run (a preview), or its latest run in the history.
function lineRun(place) {
  if (!place || dirty || !state) return null;
  const at = (e) =>
    e?.instruction?.file === place.file && e.instruction.line === place.line;
  const trace = (state.trace || []).filter((e) => e.step <= state.step);
  const ending = (i) => {
    const run = [trace[i]];
    for (let j = i - 1; j >= 0 && at(trace[j]) && trace[j].pc + 4 === run[0].pc; j--)
      run.unshift(trace[j]);
    return run;
  };
  const latest = trace.length - 1;
  if (latest >= 0 && trace[latest].step === state.step && at(trace[latest]))
    return { kind: "last", events: ending(latest), step: state.step };
  if (at(state.preview)) {
    const machine = program.instructions.filter(
      (i) => i.file === place.file && i.line === place.line,
    );
    return { kind: "next", events: machine.length === 1 ? [state.preview] : [], step: state.step + 1, pseudo: machine.length > 1 };
  }
  for (let i = latest; i >= 0; i--)
    if (at(trace[i])) return { kind: "past", events: ending(i), step: trace[i].step };
  return null;
}
// One line's explanation as a model (beats.js), or null without a record.
function lineModel(place, events) {
  const source = ((files[place.file] || "").split("\n")[place.line - 1] || "").trim();
  const options = { delay: state?.delay, instructions: program.instructions, symbols: program.symbols };
  if (events.length > 1) return lineSummary(events, { ...options, source });
  if (events.length) return beatModel(events[0], options);
  return null;
}
// The symbolic formula of a line without running it, when it is a single
// machine instruction of the loaded program.
function lineTemplate(place) {
  if (!place || dirty) return null;
  const machine = program.instructions.filter(
    (i) => i.file === place.file && i.line === place.line,
  );
  if (machine.length !== 1) return null;
  const run = lineRun(place);
  if (run?.events.length === 1) return lineModel(place, run.events).template;
  // Not run yet: the template only needs the operand names, so each register
  // field is offered as read and written with a placeholder value.
  const ins = machine[0],
    fields = [(ins.binary >>> 21) & 31, (ins.binary >>> 16) & 31, (ins.binary >>> 11) & 31];
  const reg = (number, write) => ({ kind: "register", number, name: "$" + registerNames[number], value: 0, before: 0, write });
  try {
    const m = beatModel(
      {
        instruction: ins,
        accesses: [...fields.slice(0, 2).map((n) => reg(n, false)), ...fields.slice(1).map((n) => reg(n, true))],
        nextPC: ins.address + 4,
        status: "paused",
      },
      { instructions: program.instructions, symbols: program.symbols },
    );
    return m.template?.length ? m.template : null;
  } catch {
    return null;
  }
}
const plainEq = (parts = []) =>
  parts
    .map((p) =>
      typeof p === "string" ? p : p.num ? fmt(p.v, p.w, p.k).text : p.t,
    )
    .join("");
function lineFormula(place) {
  const t = lineTemplate(place);
  return t ? `<p class="tip-formula">本行：<code>${esc(plainEq(t))}</code></p>` : "";
}
// The detailed inspector for an instruction on a line (classroom
// 2026-10-24): the rule in general, this line substituted, the values before
// it ran, the calculation, the result (or a preview, marked as such) and the
// related reads and writes. Values come from the selected history state.
function instructionDetail(token, place) {
  const source = ((files[place.file] || "").split("\n")[place.line - 1] || "").trim(),
    doc = zhDoc(token) || withOperands(program.instructionDocs[token].description, program.instructionDocs[token].example, source).text,
    run = lineRun(place),
    model = run ? lineModel(place, run.events) : null,
    template = model?.template || lineTemplate(place);
  const where = `${place.file}:${place.line}`;
  const status = dirty
    ? "代码已修改 · 重新汇编后才有数值"
    : !state
      ? "尚未汇编"
      : !run
        ? "这次运行中还没有执行到这一行"
        : run.kind === "last"
          ? `刚执行（第 ${run.step} 步）`
          : run.kind === "next"
            ? "即将执行 · 下面是预览，尚未执行"
            : `第 ${run.step} 步执行过（不是最近一步）`;
  const value = (o, v) =>
    fmt(v, o.width || 4, o.kind === "memory" ? "bits" : regKind(o.name)).text;
  const label = (o) => (o.kind === "memory" ? `内存[${hex(o.address)}]` : o.name);
  // Register names can be hovered for their conventional use.
  const labelHTML = (o) =>
    o.kind === "memory"
      ? esc(label(o))
      : `<abbr class="reg-term" title="${esc(o.name + "：" + role(o.name))}">${esc(o.name)}</abbr>`;
  const reads = (model?.objects || []).filter((o) => o.read),
    writes = (model?.objects || []).filter((o) => o.write);
  const single = (template && !(run?.events?.length > 1) && !run?.pseudo);
  const written = usage(token, source);
  const bitsEvent = (run?.events || []).find(supportsBits);
  const rows = [];
  if (template && single && !written?.formula)
    rows.push(["通用规则", `<code>${esc(genericTemplate(template, source))}</code>`]);
  if (template)
    rows.push(["本行代入", `<code>${esc(plainEq(template))}</code>`]);
  if (model) {
    // A register both read and written: the right-hand side uses the value
    // from before the write (round-4 trial: students had to infer this).
    const both = writes.filter((w) => w.kind === "register" && reads.some((r) => r.name === w.name));
    rows.push([
      run.kind === "next" ? "当前执行前数值" : "执行前数值",
      (reads.length ? reads.map((o) => `${labelHTML(o)} = <b>${esc(value(o, o.before))}</b>`).join("，") : "不读取寄存器或内存") +
        both.map((o) => `<small class="detail-when">右边的 ${esc(o.name)} 用的是执行前的 ${esc(value(o, o.before))}，结果 ${esc(value(o, o.after))} 写回后 ${esc(o.name)} 才变。</small>`).join(""),
    ]);
    rows.push([
      "计算过程",
      `<ol>${model.beats.map((b) => `<li><code>${esc(plainEq(b.eq))}</code>${b.caption ? ` <small>${esc(b.caption)}</small>` : ""}</li>`).join("")}</ol>`,
    ]);
    rows.push([
      "完成执行后数值",
      (writes.length
        ? writes.map((o) => `${labelHTML(o)}：${esc(value(o, o.before))} → <b>${esc(value(o, o.after))}</b>`).join("<br>")
        : esc(model.summary || "没有写入寄存器或内存")) +
        `<small class="detail-when">${run.kind === "next" ? "预览：尚未执行" : "执行后的实际结果"}</small>`,
    ]);
    const related = [
      reads.length && "读 " + reads.map(labelHTML).join("、"),
      writes.length && "写 " + writes.map(labelHTML).join("、"),
    ].filter(Boolean);
    if (related.length) rows.push(["关联读写", related.join(" · ")]);
  } else if (run?.pseudo)
    rows.push(["完成执行后数值", "这一行是伪指令，执行后可以看到整行的结果；在专注模式中可逐条查看展开的机器指令。"]);
  showContext(
    `<div class="inspect-head"><h3>${esc(token)}</h3><span>${esc(where)} · ${esc(status)}</span></div><p>${esc(doc)}</p>${termsIn(doc).length ? `<details class="detail-terms"><summary>术语</summary>${definitions(doc)}</details>` : ""}${written ? usageRows(written) : ""}${rows.length ? `<dl class="detail-steps">${rows.map(([t, d]) => `<dt>${t}</dt><dd>${d}</dd>`).join("")}</dl>` : ""}<div class="context-actions"><button id="detail-source">定位到这一行</button><button id="refs">查找引用</button>${bitsEvent ? `<button id="detail-bits">${run.kind === "past" ? "逐位查看（回退到那一步后可用）" : "在专注模式中逐位查看"}</button>` : ""}</div>`,
  );
  $("detail-source").onclick = () => gotoSource(place.file, place.line);
  $("refs").onclick = () => showReferences(token);
  // The bit view lives in focus mode, which shows the steps around the
  // current position: the line just run (-1) or about to run (0).
  if (bitsEvent) {
    $("detail-bits").disabled = run.kind === "past";
    $("detail-bits").onclick = () => {
      if (dirty || !state) return;
      lens.openAt(run.kind === "next" ? 0 : -1, { bits: true });
    };
  }
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
// After the program has ended, the backend's preview is merely the next
// instruction in memory, which will never run (round-4 trial: an arrow on
// helper.s after exit read as "not finished"), so it is dropped here.
function named(s) {
  if (s.status === "ended") s.preview = null;
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
// Commands that execute or move through the loaded program's history. They
// wait while the loaded program is not the one being looked at (P0).
const EXECUTING = new Set([
  "step",
  "source",
  "over",
  "out",
  "run",
  "back",
  "seek",
  "line",
  "input",
]);
async function command(name, extra = {}) {
  if (busy) return null;
  if (EXECUTING.has(name) && blocked()) {
    notify(blocked(), { transient: true });
    return null;
  }
  busy = true;
  updateControls();
  try {
    let s = await api({
      command: name,
      programVersion: state?.programVersion,
      ...lookahead(),
      ...extra,
    });
    const before = state;
    state = s;
    appendLogs(s.logs);
    render();
    ioAttention(name, before, s);
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
    savedEditor();
    if (!Object.keys(files).length) throw Error("请先新建或导入一个 .s / .asm 源码文件。");
    // Only the scope goes to the assembler: auto (main plus the files it
    // uses), the single open file, or the manual selection. Other exercises
    // stay in the tree (P0).
    const scope = nextScope();
    if (scope.error) throw Error(scope.error);
    state = await api({
      command: "assemble",
      files: Object.fromEntries(scope.files.map((n) => [n, files[n]])),
      data,
      entry: scope.entry,
      delay: $("delay").checked,
      ...lookahead(),
    });
    target = { mode: scope.mode, files: [...scope.files], entry: scope.entry };
    lastInTarget = target.files.includes(activeFile) ? activeFile : target.entry;
    program = {
      instructions: state.instructions || [],
      symbols: state.symbols || [],
      instructionDocs: state.instructionDocs || {},
    };
    dirty = false;
    // An error had brought the problems list forward; a clean assembly puts
    // the console back (round-4 trial: output stayed hidden behind it).
    if (!state.error && problemsShownForError && bottom === "problems") setBottom("console");
    problemsShownForError = false;
    // Breakpoints live on file:line. Those in files outside this assembly
    // stay listed but inactive, and come back when the file is assembled.
    breakpoints = breakpoints.map((b) => ({
      ...b,
      address: program.instructions.find(
        (i) => i.file === b.file && i.line === b.line,
      )?.address,
    }));
    debugLog = [];
    notify(state.error || "");
    render();
    // Reassembling keeps the file being read (round-3 trial: it jumped back to
    // main.s); the status chip still says where execution starts.
    const start = program.instructions.find((i) => i.address === state.pc);
    if (
      !activeFile ||
      !start ||
      start.file === activeFile ||
      !target.files.includes(activeFile)
    )
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
  if (activeFile && Object.hasOwn(files, activeFile)) files[activeFile] = editor.state.doc.toString();
}
function switchFile(file) {
  if (!Object.hasOwn(files, file)) return;
  savedEditor();
  if (activeFile) fileStates.set(activeFile, editor.state.selection);
  activeFile = file;
  if (target?.files.includes(file)) lastInTarget = file;
  workspace?.opened(file);
  loadEditor = true;
  editor.dispatch({
    effects: fileAccess.reconfigure([EditorState.readOnly.of(false), EditorView.editable.of(true)]),
    changes: { from: 0, to: editor.state.doc.length, insert: files[file] },
    selection: fileStates.get(file) || { anchor: 0 },
  });
  loadEditor = false;
  renderTabs();
  renderFiles();
  updateControls();
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
// rest of the code also dims for a moment so the eye lands on it. One pulse,
// and a new stop cancels the previous one (2026-10-23 feedback: two pulses per
// stop, and fast stepping left a trail of flashing lines).
let arrivedAt = null;
function arrive(jumped = false) {
  const ins = program.instructions.find((i) => i.address === executionPC());
  if (!ins || view !== "source" || dirty) return;
  const far =
    jumped ||
    !arrivedAt ||
    arrivedAt.file !== ins.file ||
    Math.abs(arrivedAt.line - ins.line) > 1;
  arrivedAt = { file: ins.file, line: ins.line };
  // An ended program has no next line to point at.
  if (state.status === "ended") return;
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  requestAnimationFrame(() => {
    const line = editor.dom.querySelector(".cm-line.next-line");
    arrive.pulse?.cancel();
    arrive.pulse = line?.animate(
      [
        { background: "color-mix(in srgb, var(--exec-strong) 45%, var(--panel))" },
        { background: "color-mix(in srgb, var(--exec) 55%, transparent)" },
      ],
      { duration: 700, iterations: 1, easing: "ease-out" },
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
// The debugger moving the editor to where execution is, as opposed to the
// student switching tabs: it never records navigation and only ever opens
// files of the loaded program, so it cannot make the program look outdated.
// Where execution is: the next instruction, or once the program has ended,
// the last one that ran (the PC then points past the exit).
const executionPC = () =>
  state?.status === "ended" ? state.last?.pc : state?.pc;
function followPC() {
  let ins = program.instructions.find((i) => i.address === executionPC());
  if (ins && target && !target.files.includes(ins.file)) return;
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
    // A moment's notice, not a lasting state (round-3 trial: after a run
    // ended in another file it stayed and read as "still running there").
    notify(`执行进入 ${ins.file}${label ? " · " + label.name : ""}`, {
      transient: true,
    });
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
// Terminal attention (classroom 2026-10-24): only real execution draws the
// eye to the console. New output pulses it once, and a new pulse replaces the
// last so fast stepping never stacks flashes; reduced motion gets a static
// mark instead. Waiting for input brings the console forward and lights the
// input box until it is answered. Seeking, refreshing and previews never do,
// and keyboard focus stays where it is.
const PRODUCING = new Set(["step", "source", "over", "out", "run", "input"]);
function ioAttention(name, before, after) {
  if (!PRODUCING.has(name) || !after || after.programVersion !== before?.programVersion) return;
  if (after.status === "waiting" && before.status !== "waiting" && bottom !== "console")
    setBottom("console");
  const grew = (after.output || "").length > (before.output || "").length;
  if (!grew && name !== "input") return;
  const tab = document.querySelector('[data-bottom="console"]');
  if (bottom !== "console") tab.classList.add("unread");
  const target =
    bottom !== "console"
      ? tab
      : name === "input"
        ? [...$("output").querySelectorAll(".echo")].at(-1) || $("output")
        : $("output");
  ioAttention.pulse?.cancel();
  clearTimeout(ioAttention.timer);
  document.querySelectorAll(".fresh-output").forEach((e) => e.classList.remove("fresh-output"));
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
    target.classList.add("fresh-output");
    ioAttention.timer = setTimeout(() => target.classList.remove("fresh-output"), 1500);
  } else
    ioAttention.pulse = target.animate(
      [
        { background: "color-mix(in srgb, var(--green, #268058) 26%, transparent)" },
        { background: "transparent" },
      ],
      { duration: 700, easing: "ease-out" },
    );
}
function setBottom(v) {
  bottom = v;
  if (v === "logs") $("logs-tab").classList.remove("unread");
  if (v === "console")
    document.querySelector('[data-bottom="console"]').classList.remove("unread");
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
  // "Modified" only makes sense once a program was loaded (round-4 trial:
  // a fresh project already said its source had been modified).
  if (!target || !state || state.status === "empty")
    return { kind: "idle", text: "尚未汇编 · 点“汇编”开始" };
  if (dirty) return { kind: "dirty", text: "源码已修改 · 重新汇编后继续" };
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
    return { kind: "ended", text: `已结束 · 退出码 ${state.exitCode}`, at: last };
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
// Why execution buttons are unavailable, in the student's words (round-4
// trial: a grey run button did not say whether the program had ended or the
// open file was not the loaded one).
function executionBlock() {
  if (busy) return "正在处理上一个操作";
  if (running) return "程序正在运行";
  if (!state || state.status === "empty" || !target) return "还没有汇编：先点“汇编”";
  if (dirty) return "代码已修改：先重新汇编";
  const reason = scopeReason();
  if (reason?.kind === "outside") return `正在查看 ${activeFile}，它不在现在能运行的程序里`;
  if (reason) return "汇编方式或范围已更改：先重新汇编";
  if (state.status === "ended") return "程序已结束";
  if (state.status === "error") return "程序出错停下了：修改后重新汇编";
  return "";
}
// After the program ends, run starts it again from the beginning: the
// loaded program is assembled anew (breakpoints follow their file:line, and
// input is asked for again rather than replayed) and then run.
const canRestart = () =>
  state?.status === "ended" && !busy && !running && !dirty && !blocked();
async function restartRun() {
  await assemble();
  if (state?.status === "paused" && !state.error) await run("run");
}
function updateControls() {
  const gate = blocked(),
    why = executionBlock();
  for (let name of ["step", "source", "over", "out", "run", "demo"])
    $(name).disabled =
      busy ||
      dirty ||
      !!gate ||
      running ||
      !state ||
      !["paused", "waiting"].includes(state.status);
  $("back").disabled = busy || dirty || !!gate || running || !state?.step;
  const restart = canRestart();
  if (restart) $("run").disabled = false;
  // One button per action (classroom 2026-10-31): whichever started the
  // machine pauses it, and a paused demonstration offers to continue.
  if (!state?.step || state.status === "ended" || dirty) demoPaused = false;
  const pausable = (demo) => running && !stopRequested && demo === demoing;
  if (pausable(false)) $("run").disabled = false;
  if (pausable(true)) $("demo").disabled = false;
  $("run").textContent = pausable(false) ? "Ⅱ 暂停" : restart ? "↻ 从头运行" : "▶ 运行";
  $("run").setAttribute("aria-label", pausable(false) ? "暂停（F6）" : restart ? "从头运行（F5）" : "运行（F5）");
  $("demo").textContent = pausable(true) ? "Ⅱ 暂停" : demoPaused ? "▶ 继续" : "▷ 演示";
  $("demo").setAttribute("aria-label", pausable(true) ? "暂停演示（F6）" : demoPaused ? "继续演示" : "演示");
  for (const name of ["back", "step", "source", "over", "out", "run", "demo"]) {
    const b = $(name);
    b.dataset.tipBase ??= b.dataset.tip || "";
    b.dataset.tip =
      (name === "run" || name === "demo") && running && !b.disabled
        ? "暂停 · F6"
        : name === "demo" && demoPaused && !b.disabled
          ? "继续演示：从当前位置接着逐条执行"
          : name === "run" && restart
            ? "从头运行：重新汇编当前程序并运行 · F5"
            : b.disabled && why
              ? `${b.dataset.tipBase}（${why}）`
              : b.dataset.tipBase;
  }
  // Assembling first stops a run, so it stays available through one; tying
  // it to `busy` alone blinked the button on every demonstration step.
  $("assemble").disabled = busy && !running;
  renderScope();
  tutorial?.update();
  const info = statusInfo();
  $("status").textContent = info.text;
  $("status").dataset.state = info.kind;
  $("status").onclick = info.at
    ? () => gotoSource(info.at.file, info.at.line)
    : null;
  $("status").title = info.at ? "点击跳到这一行" : "";
}
function nextScope() {
  return assemblyScope(
    {
      files,
      assembly: workspace?.assembly() || { mode: "auto", files: [] },
      entry: workspace?.entry() || "",
    },
    activeFile,
  );
}
const MODE_NAMES = { auto: "自动汇编", single: "单文件汇编", manual: "手动范围" };
const describeScope = (s) =>
  s.error
    ? "（尚未选好源码）"
    : s.files.length > 1
      ? `${MODE_NAMES[s.mode]} ${s.files.length} 个文件（入口 ${s.entry}）`
      : `${MODE_NAMES[s.mode]} ${s.entry}`;
const sameFiles = (a, b) =>
  [...a].sort().join("\n") === [...b].sort().join("\n");
// Why the loaded program must not run right now, if it must not: the student
// switched to a source outside it, or changed the way or the manual scope.
// Following execution into another file never causes this, because execution
// only reaches files inside the target.
// The loaded program in words: "hello.s", or "lab/main.s 和另外 1 个文件".
const runnable = (t) =>
  t.files.length > 1 ? `${t.entry} 和另外 ${t.files.length - 1} 个文件` : t.entry;
// The banner says what can run now and what to click next (round-4 trial:
// "已装入" needed thought, and "不会运行旧程序" read as "running is off").
function scopeReason() {
  if (!state || !target || !workspace) return null;
  const back = target.files.includes(lastInTarget) ? lastInTarget : target.entry;
  if (
    activeFile &&
    Object.hasOwn(files, activeFile) &&
    !target.files.includes(activeFile)
  )
    return {
      kind: "outside",
      back,
      text:
        target.mode === "manual"
          ? `${activeFile} 不在手动选择的范围里，现在能运行的是 ${runnable(target)}。`
          : `你在看 ${activeFile}，现在能运行的是 ${runnable(target)}。要运行 ${activeFile}，先点［${assembleLabel()}］；也可以［回到 ${back}］继续调试。`,
    };
  const scope = nextScope();
  if (
    scope.mode !== target.mode ||
    (scope.mode === "manual" &&
      (scope.entry !== target.entry || !sameFiles(scope.files, target.files)))
  )
    return {
      kind: "changed",
      text: `${scope.mode !== target.mode ? `汇编方式改成了${{ auto: "自动汇编", single: "单文件汇编", manual: "手动选择范围" }[scope.mode]}` : "手动选择的范围改了"}，但现在能运行的还是之前装入的程序（${runnable(target)}）。点［重新汇编］按新方式装入。`,
    };
  return null;
}
function blocked() {
  return scopeReason()?.text || "";
}
// What the banner's assemble button says for the file being viewed.
function assembleLabel() {
  const scope = nextScope();
  return !scope.error && scope.entry !== activeFile
    ? `汇编（入口 ${scope.entry}）`
    : `汇编 ${activeFile}`;
}
function renderScope() {
  const scope = nextScope(),
    reason = scopeReason();
  $("target").textContent = !target
    ? "程序：未汇编"
    : target.files.length > 1
      ? `程序：${target.entry} ＋${target.files.length - 1} 个文件`
      : `程序：${target.entry}`;
  $("target").title = target
    ? `${MODE_NAMES[target.mode]}，现在能运行的程序由这些源码汇编：\n` +
      target.files.join("\n") +
      "\n点“汇编”后会换成新的程序"
    : "还没有汇编";
  $("target").classList.toggle("stale", !!reason);
  $("assemble").title =
    (scope.error || describeScope(scope)) +
    " · Cmd/Ctrl+Enter；重新汇编并重启 · Cmd/Ctrl+Shift+F5";
  document
    .querySelectorAll("[data-assembly-mode]")
    .forEach((b) =>
      b.setAttribute(
        "aria-checked",
        String(b.dataset.assemblyMode === scope.mode),
      ),
    );
  const banner = $("scope-banner");
  banner.hidden = !reason;
  if (!reason) return banner.replaceChildren();
  const actions =
    reason.kind === "changed"
      ? [["assemble", "重新汇编"]]
      : target.mode === "manual"
        ? [
            ["back", `回到 ${reason.back}`],
            ["join", `把 ${activeFile} 加入范围`],
          ]
        : [
            ["assemble", assembleLabel()],
            ["back", `回到 ${reason.back}`],
          ];
  banner.innerHTML = `<span>${esc(reason.text)}</span>${actions
    .map(
      ([a, label]) =>
        `<button data-scope-action="${a}">${esc(label)}</button>`,
    )
    .join("")}`;
  banner.querySelectorAll("[data-scope-action]").forEach(
    (b) =>
      (b.onclick = () => {
        const a = b.dataset.scopeAction;
        if (a === "assemble") assemble();
        else if (a === "back") {
          setView("source");
          switchFile(
            target.files.includes(lastInTarget) ? lastInTarget : target.entry,
          );
        } else if (a === "join")
          workspace.setAssembly({
            files: [...workspace.assembly().files, activeFile],
          });
      }),
  );
}
// Menus in the header (classroom 2026-10-24): project actions and interface
// settings each open from one button; a chosen item closes its menu.
function setupMenu(buttonId, menuId) {
  const button = $(buttonId),
    menu = $(menuId);
  const close = () => {
    menu.hidden = true;
    button.setAttribute("aria-expanded", "false");
  };
  button.addEventListener("click", (e) => {
    e.stopPropagation();
    const open = menu.hidden;
    document.querySelectorAll(".menu").forEach((m) => (m.hidden = true));
    menu.hidden = !open;
    button.setAttribute("aria-expanded", String(open));
    if (open) menu.querySelector("button:not(:disabled)")?.focus();
  });
  menu.addEventListener("click", (e) => {
    if (e.target.closest('[role="menuitem"]')) close();
  });
  menu.addEventListener("keydown", (e) => {
    const items = [...menu.querySelectorAll("button:not(:disabled)")],
      at = items.indexOf(document.activeElement);
    if (e.key === "Escape") {
      close();
      button.focus();
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp")
      items[(at + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length]?.focus();
    else return;
    e.preventDefault();
    e.stopPropagation();
  });
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".menu-wrap")) close();
  });
}
setupMenu("project-menu-button", "project-menu");
setupMenu("view-menu-button", "view-menu");
// Left side: files, symbols, and breakpoints with watchpoints, one at a time.
// A breakpoint or watchpoint hit while that group is hidden marks its tab.
const SIDE_TABS = ["files", "symbols", "stops"];
let sideTab = "files",
  lastStopKey = "";
function setSideTab(name, focusTab = false) {
  sideTab = SIDE_TABS.includes(name) ? name : "files";
  for (const n of SIDE_TABS) {
    const tab = $("side-tab-" + n);
    tab.setAttribute("aria-selected", String(n === sideTab));
    tab.tabIndex = n === sideTab ? 0 : -1;
    $("side-" + n).hidden = n !== sideTab;
  }
  if (sideTab === "stops") $("stops-badge").hidden = true;
  if (focusTab) $("side-tab-" + sideTab).focus();
  tutorial?.update();
  try {
    localStorage.setItem("side-tab", sideTab);
  } catch {}
}
document.querySelectorAll("[data-side]").forEach((b) => {
  b.onclick = () => setSideTab(b.dataset.side);
});
document.querySelector(".side-tabs").addEventListener("keydown", (e) => {
  const at = SIDE_TABS.indexOf(sideTab);
  const to =
    e.key === "ArrowDown" || e.key === "ArrowRight"
      ? (at + 1) % 3
      : e.key === "ArrowUp" || e.key === "ArrowLeft"
        ? (at + 2) % 3
        : e.key === "Home"
          ? 0
          : e.key === "End"
            ? 2
            : -1;
  if (to < 0) return;
  e.preventDefault();
  setSideTab(SIDE_TABS[to], true);
});
function noteStop() {
  const key = `${state?.programVersion}:${state?.step}:${state?.stopReason}`;
  if (key === lastStopKey) return;
  lastStopKey = key;
  if (/^(Breakpoint|Watchpoint)/.test(state?.stopReason || "") && sideTab !== "stops")
    $("stops-badge").hidden = false;
}
// Right side: each panel folds to its title; the lowest open panel takes the
// remaining height, and a splitter only sits between two open panels.
const PANELS = ["context", "registers", "memory"];
function layoutPanels() {
  const open = PANELS.filter((n) => !$("panel-" + n).classList.contains("collapsed"));
  for (const n of PANELS) $("panel-" + n).classList.toggle("fill", n === open.at(-1));
  $("split-context").hidden = !open.includes("context") || open.at(-1) === "context";
  $("split-registers").hidden = !open.includes("registers") || open.at(-1) === "registers";
  editor.requestMeasure();
  overlay.schedule();
}
function setPanel(name, collapsed) {
  const panel = $("panel-" + name);
  panel.classList.toggle("collapsed", collapsed);
  panel.querySelector(".panel-toggle").setAttribute("aria-expanded", String(!collapsed));
  try {
    localStorage.setItem("panel-" + name, collapsed ? "collapsed" : "open");
  } catch {}
  layoutPanels();
}
document.querySelectorAll(".panel-toggle").forEach((b) => {
  const name = b.closest(".panel").id.replace("panel-", "");
  b.onclick = () => setPanel(name, !b.closest(".panel").classList.contains("collapsed"));
});
try {
  setSideTab(localStorage.getItem("side-tab") || "files");
  for (const n of PANELS)
    if (localStorage.getItem("panel-" + n) === "collapsed") setPanel(n, true);
} catch {}
layoutPanels();
$("reset-layout").onclick = () => {
  for (const split of Object.values(panelSplits)) setSplit(split, null);
  for (const n of PANELS) setPanel(n, false);
  setSideTab("files");
  notify("已恢复默认布局。", { transient: true });
};
// The main editor's relation lines are configured where those relations are
// studied: in focus mode (classroom 2026-10-24). The settings move there
// whole, so every option stays available.
document.querySelector(".overlay-settings summary").textContent = "主界面连线";
$("focus-keys").before(document.querySelector(".overlay-settings"));
// The way of assembling sits beside the assemble button (2026-10-24): auto by
// default, single file, or a manual scope checked in the file tree.
function closeAssembleMenu() {
  $("assemble-menu").hidden = true;
  $("assemble-mode").setAttribute("aria-expanded", "false");
}
$("assemble-mode").onclick = (e) => {
  e.stopPropagation();
  const open = $("assemble-menu").hidden;
  $("assemble-menu").hidden = !open;
  $("assemble-mode").setAttribute("aria-expanded", String(open));
  if (open)
    $("assemble-menu").querySelector('[aria-checked="true"]')?.focus();
};
document.querySelectorAll("[data-assembly-mode]").forEach(
  (b) =>
    (b.onclick = () => {
      closeAssembleMenu();
      workspace.setAssembly({ mode: b.dataset.assemblyMode });
      if (b.dataset.assemblyMode === "manual")
        document
          .querySelector(".assembly-choice")
          ?.scrollIntoView({ block: "nearest" });
    }),
);
$("assemble-menu").addEventListener("keydown", (e) => {
  const items = [...$("assemble-menu").querySelectorAll("button")],
    at = items.indexOf(document.activeElement);
  if (e.key === "Escape") {
    closeAssembleMenu();
    $("assemble-mode").focus();
  } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    items[(at + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length].focus();
  } else return;
  e.preventDefault();
  e.stopPropagation();
});
document.addEventListener("click", (e) => {
  if (!e.target.closest(".split-button")) closeAssembleMenu();
});
function renderFiles() {
  workspace?.render();
}
function renderTabs() {
  const tabs = workspace?.tabs() || Object.keys(files);
  $("tabs").innerHTML = tabs.map(f =>
    `<span class="file-tab ${f === activeFile ? 'active' : ''}"><button data-tab="${esc(f)}" title="${esc(f)}">${esc(f)}</button><button class="close-tab" data-close-tab="${esc(f)}" aria-label="关闭标签 ${esc(f)}" title="关闭标签，文件仍在工程中">×</button></span>`
  ).join('') || '<span class="empty-tab">从左侧选择文件，或新建文件</span>';
  $("tabs").querySelectorAll('[data-tab]').forEach(b => b.onclick=()=>{setView("source");switchFile(b.dataset.tab);});
  $("tabs").querySelectorAll('[data-close-tab]').forEach(b => b.onclick=()=>workspace.closeTab(b.dataset.closeTab));
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
  // BIN shows all 32 bits with leading zeros (classroom 2026-10-24: values
  // were cut off); registers then take a full row each and wrap only at byte
  // boundaries, so the bit order is never broken up or reflowed.
  const bin = radix === "bin";
  const shown = (r) =>
    bin
      ? esc(fmt(r.value, 4, regKind(r.name)).full).replace(/_/g, (m, i, all) =>
          (all.slice(2, i).match(/_/g) || []).length % 2 ? "_<wbr>" : "_",
        )
      : esc(fmt(r.value, 4, regKind(r.name)).text);
  $("registers").classList.toggle("bin", bin);
  // What the prefixes mean, right where the values are (round-4 trial: the
  // footer legend went unnoticed).
  $("reg-legend").textContent = {
    auto: "0d 十进制 · 0x 十六进制",
    hex: "0x 十六进制",
    dec: "0d 十进制",
    bin: "0b 二进制",
    ascii: "'…' 字符 · 0d 十进制",
  }[radix];
  // A negative value in BIN: the top bit says so (two's complement).
  const signNote = (r) =>
    bin && r.value < 0 && regKind(r.name) === "value"
      ? `\n最高位是 1：按有符号数读是 ${r.value | 0}（补码）`
      : "";
  $("registers").innerHTML = state.registers
    .filter((r) =>
      filter === "all" || filter === "pinned"
        ? filter === "all" || pinned.has(r.name)
        : related.has(r.name) || pinned.has(r.name),
    )
    .map(
      (r) =>
        `<div tabindex="0" class="reg ${all.some((a) => a.name === r.name && !a.write) ? "read" : ""} ${all.some((a) => a.name === r.name && a.write) ? "write" : ""} ${pinned.has(r.name) ? "pinned" : ""} ${focus === r.name ? "focus" : ""}" data-register="${r.name}" title="${r.name} · ${esc(role(r.name))}\n${esc(fmt(r.value, 4, regKind(r.name)).full)}${fmt(r.value, 4, regKind(r.name)).note ? " · " + esc(fmt(r.value, 4, regKind(r.name)).note) : ""}${esc(signNote(r))}\n前缀：${esc($("reg-legend").textContent)} · 点击查看"><span class="name">${r.name}</span><span class="value">${shown(r)}</span></div>`,
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
  following = false;
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
    state?.status === "ended"
      ? `<small>即将执行</small><b>程序已结束 · 退出码 ${state.exitCode}</b>`
      : `<small>即将执行 ${next?.instruction ? "#" + next.step : ""} · 虚线 ${next?.status === "waiting-input" ? "· 等待输入" : ""}</small><b>${esc(next?.instruction ? sourceOf(next.instruction) : "—")}</b>`;
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
        inspectToken(e.instruction.op, e.instruction);
      }
    };
  }
}
function renderMachine() {
  $("machine").innerHTML = program.instructions
    .map(
      (i) =>
        `<div class="instruction ${i.address === state?.pc && state.status !== "ended" ? "next" : ""} ${i.address === state?.last?.pc ? "last" : ""}" data-instruction="${i.address}"><span data-machine-bp="${i.address}">${breakpointGlyph(breakpoints.find((b) => b.address === i.address))}</span><span>${hex(i.address).slice(2)}</span><span>${esc(i.basic)}</span><small>${esc(i.file)}:${i.line} · ${hex(i.binary)} · ${esc(i.source?.trim())}</small></div>`,
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
          inspectToken(ins.op, ins);
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
  noteStop();
  const waiting = state.status === "waiting" && !dirty;
  $("console").classList.toggle("waiting", waiting);
  $("stdin").placeholder = waiting
    ? "程序在等待输入：在这里输入后按 Enter"
    : "输入值，按 Enter 提交";
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
  // Diagnostics about the assembly scope say which files are involved.
  const hints = target ? scopeHints(state.diagnostics, { files }, target) : [];
  $("problems").innerHTML =
    state.diagnostics
      .map(
        (d, i) =>
          `<button class="command-item" data-diagnostic="${i}">${esc(d.file)}:${d.line} · ${esc(d.message)}${hints[i] ? `<small class="scope-hint">${esc(hints[i])}</small>` : ""}</button>`,
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
    notify(hints.find(Boolean) || state.error);
    setBottom("problems");
    problemsShownForError = true;
  } else if (!dirty && !keepNotice) notify("");
  editor.dispatch({ effects: refresh.of(null) });
  if (view === "machine") renderMachine();
  if (view === "cfg") renderCFG();
  // A pinned object stays and its values follow the selected state;
  // otherwise the inspector follows execution.
  if (following) followInspector();
  else if (
    inspecting &&
    (inspecting.startsWith("$") ||
      inspecting === "hi" ||
      inspecting === "lo" ||
      /\(\$\w+\)$/.test(inspecting) ||
      inspecting === "syscall" ||
      (isInstruction(inspecting) && inspectingPlace))
  )
    inspectToken(inspecting, inspectingPlace, { refresh: true });
  overlay.schedule();
  updateControls();
}
// Breakpoints carry VS Code's options: enabled, condition, hit count (pause
// before the Nth execution since S0) and logpoint message (log, don't pause).
function activeBreakpoints() {
  return breakpoints
    .filter((b) => b.enabled && b.address != null)
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
  const kept = breakpoints.find(
    (b) => b.file === activeFile && b.line === line && b.address == null,
  );
  if (kept) {
    breakpoints = breakpoints.filter((b) => b !== kept);
    breakpointChanged();
    return;
  }
  if (target && !target.files.includes(activeFile)) {
    notify(`${activeFile} 没有参与当前汇编；汇编它之后才能在这里设断点。`, {
      transient: true,
    });
    return;
  }
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
        <button class="bp ${b.address == null ? "stale" : ""}" data-bp="${i}">${breakpointGlyph(b)} ${esc(b.file)}:${b.line}<br><small>${esc(b.address == null ? "未参与汇编 · 暂不生效" : details.join(" · ") || hex(b.address))}</small></button>
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
  demoing = false,
  demoPaused = false,
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
  if (blocked()) {
    notify(blocked(), { transient: true });
    return;
  }
  running = true;
  demoing = mode === "demo";
  demoPaused = false;
  stopRequested = false;
  let finish;
  runDone = new Promise((resolve) => (finish = resolve));
  try {
    await runLoop(mode, extra);
  } finally {
    running = false;
    stopRequested = false;
    demoPaused = demoing && ["paused", "waiting"].includes(state?.status);
    demoing = false;
    updateControls();
    finish();
  }
  arrive(mode !== "source");
  followInspector();
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
    workspace?.changed();
    $("modal").close();
    assemble();
  };
  $("data-delete").onclick = () => {
    $("modal").close();
    workspace.apply({...workspace.snapshot(), data: Object.fromEntries(Object.entries(data).filter(([n])=>n!==name))}).catch(e=>notify(e.message));
  };
}
function commandList() {
  const commands = [
    ["汇编工程", assemble, "assemble"],
    ["新建空白工程", () => $("new-project").click()],
    ["打开工程（替换工作区）", () => $("import").click()],
    ["添加文件到工程", () => $("add-import").click()],
    ["保存工程到浏览器", () => $("save-local").click()],
    ["导出工程 ZIP／JSON", () => $("save").click()],
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
    ["syscall 一览（$v0 的值对应做什么）", () => inspectToken("syscall")],
    ["查指令与用途（按名称或想做的事搜索）", () => findInstruction()],
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
// Find an instruction or syscall service by name or by what one wants to do
// (classroom 2026-10-24). Results say what it is for, its operands, the
// general formula, an example and its limits, and where this project uses
// it. Searching never edits code.
function findInstruction(query = "") {
  const items = instructionIndex(program.instructionDocs);
  modal(
    "查指令与用途",
    `<input id="find-input" aria-label="搜索指令或用途" autocomplete="off" placeholder="例如：add、加法、比较大小、打印字符、读取整数、右移" style="width:100%"><div id="find-list" role="listbox" aria-label="搜索结果"></div><div id="find-detail" aria-live="polite"></div>`,
  );
  const input = $("find-input");
  input.value = query;
  let results = [],
    selected = 0;
  const kindOf = (x) => (x.kind === "service" ? "syscall" : x.pseudo ? "伪指令" : "指令");
  // Where this project uses it: lines with the instruction, or syscalls
  // whose service number (from the li $v0 above) is this one.
  const uses = (x) => {
    const out = [];
    for (const [file, text] of Object.entries(files)) {
      const lines = text.split("\n");
      lines.forEach((t, i) => {
        const code = t.replace(/#.*/, "").replace(/^\s*(?:[\w.$]+:\s*)*/, "");
        const op = code.trim().split(/\s+/)[0];
        if (x.kind === "service"
          ? op === "syscall" && serviceAt({ lines, line: i + 1 }).n === x.service
          : op === x.op)
          out.push({ file, line: i + 1, text: t.trim() });
      });
    }
    return out.slice(0, 6);
  };
  const detail = () => {
    const x = results[selected];
    if (!x) {
      $("find-detail").innerHTML = input.value.trim()
        ? '<p class="muted">没有找到匹配的指令或 syscall。试试“加法”“比较大小”“打印字符”“读取整数”“右移”，或输入指令名。</p>'
        : '<p class="muted">输入指令名，或用中文写想做的事。</p>';
      return;
    }
    const used = uses(x);
    const rows = [
      ["用途", esc(x.purpose)],
      ["格式", `<code class="find-code">${esc(x.format)}</code>`],
      x.formula && ["通用公式", `<code>${esc(x.formula)}</code>`],
      x.example && x.example !== x.format && ["例子", `<code class="find-code">${esc(x.example)}</code>`],
      x.note && ["说明", esc(x.note)],
    ].filter(Boolean);
    $("find-detail").innerHTML = `<div class="inspect-head"><h3>${esc(x.label)}</h3><span>${kindOf(x)}</span></div><dl class="detail-steps">${rows.map(([t, d]) => `<dt>${t}</dt><dd>${d}</dd>`).join("")}</dl>${used.length ? `<p class="muted">本工程中用到的地方（点击查看这一行的详细检查）：</p>${used.map((u, i) => `<button class="command-item" data-use="${i}">${esc(u.file)}:${u.line} <small class="mono">${esc(u.text)}</small></button>`).join("")}` : '<p class="muted">本工程里还没有用到它。</p>'}`;
    $("find-detail")
      .querySelectorAll("[data-use]")
      .forEach(
        (b) =>
          (b.onclick = () => {
            const u = used[Number(b.dataset.use)];
            $("modal").close();
            gotoSource(u.file, u.line);
            inspectToken(x.op, { file: u.file, line: u.line });
          }),
      );
  };
  // Loose matches fold away under "其他可能相关" when strong ones exist.
  let moreOpen = false;
  const render = () => {
    results = searchInstructions(input.value, items);
    const strong = results.filter((x) => !x.weak).length,
      folded = strong > 0 && strong < results.length && !moreOpen;
    const visible = folded ? strong : results.length;
    selected = Math.max(0, Math.min(selected, visible - 1));
    const row = (x, i) =>
      `<button class="command-item ${i === selected ? "selected" : ""}" role="option" aria-selected="${i === selected}" data-find="${i}"><b>${esc(x.label)}</b> <small>${kindOf(x)}</small> <span class="muted">${esc(x.purpose)}</span></button>`;
    $("find-list").innerHTML =
      strong > 0 && strong < results.length
        ? results.slice(0, strong).map(row).join("") +
          `<details class="find-more" ${moreOpen ? "open" : ""}><summary>其他可能相关（${results.length - strong} 个）</summary>${results.slice(strong).map((x, k) => row(x, strong + k)).join("")}</details>`
        : results.map(row).join("");
    const more = $("find-list").querySelector(".find-more");
    if (more)
      more.ontoggle = () => {
        if (more.open !== moreOpen) {
          moreOpen = more.open;
          render();
        }
      };
    $("find-list")
      .querySelectorAll("[data-find]")
      .forEach(
        (b) =>
          (b.onclick = () => {
            selected = Number(b.dataset.find);
            render();
          }),
      );
    $("find-list").querySelector(".selected")?.scrollIntoView({ block: "nearest" });
    detail();
  };
  input.oninput = () => {
    selected = 0;
    moreOpen = false;
    render();
  };
  input.onkeydown = (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      selected += e.key === "ArrowDown" ? 1 : -1;
      render();
    } else if (e.key === "Enter") {
      e.preventDefault();
      $("find-detail").querySelector("[data-use]")?.focus();
    }
  };
  render();
  input.focus();
}
$("find-instruction").onclick = () => findInstruction();
// The introduction runs in a project of its own; the student's project is
// kept aside and can be restored at the end (classroom 2026-10-24).
const TUTORIAL_BACKUP = "tutorial-backup";
tutorial = new Tutorial({
  context: () => ({
    files,
    activeFile,
    state: dirty ? null : state,
    target,
    dirty,
    breakpoints,
    watches,
    // Only what the student opened counts, not what the inspector followed.
    inspecting: following ? null : inspecting,
    lensOpen: lens.isOpen,
    sideTab,
  }),
  go: (action) => {
    const [kind, arg] = action.split(/:(.*)/);
    if (kind === "side") setSideTab(arg, true);
    else if (kind === "panel") setPanel(arg, false);
    else if (kind === "inspect") {
      setPanel("context", false);
      inspectToken(arg);
    }
    else if (kind === "find") findInstruction(arg);
    else if (kind === "focus") openFocus();
    // After the current click finishes, or its bubbling would close the menu.
    else if (kind === "menu") setTimeout(() => $("project-menu-button").click());
  },
  finish: (completed) => {
    let saved = null;
    try {
      saved = JSON.parse(localStorage.getItem(TUTORIAL_BACKUP) || "null");
    } catch {}
    modal(
      completed ? "入门练习完成" : "退出入门练习",
      `<p>${completed ? "做得好！" : ""}练习工程会留在工作区，可以继续修改或导出。${saved ? `也可以回到练习前的工程“${esc(saved.name || "我的工程")}”。` : ""}</p><div class="project-actions"><button id="tutorial-continue">继续练习</button>${saved ? '<button id="tutorial-restore">回到之前的工程</button>' : ""}<button class="primary" id="tutorial-keep">保留练习工程</button></div>`,
    );
    $("tutorial-continue").onclick = () => $("modal").close();
    $("tutorial-keep").onclick = () => {
      $("modal").close();
      tutorial.stop();
    };
    if (saved)
      $("tutorial-restore").onclick = async () => {
        try {
          await workspace.apply(saved);
          $("modal").close();
          tutorial.stop();
          localStorage.removeItem(TUTORIAL_BACKUP);
        } catch (e) {
          notify(e.message);
        }
      };
  },
});
$("start-tutorial").onclick = () => {
  if (tutorial.active) {
    tutorial.collapsed = false;
    return tutorial.update();
  }
  modal(
    "入门练习：Hello World",
    `<p class="project-explanation">边写边学：从打印 Hello! 开始，读取你的名字，用断点、详细检查和专注模式看清它，找到一个溢出错误并修好，最后自己加一个功能并导出。</p><p class="muted">练习会打开一个单独的练习工程。当前工程会先保存一份，结束时可以回到它；你的代码不会被覆盖。</p><div class="project-actions"><button id="tutorial-cancel">取消</button><button class="primary" id="tutorial-begin">开始练习</button></div>`,
  );
  $("tutorial-cancel").onclick = () => $("modal").close();
  $("tutorial-begin").onclick = async () => {
    try {
      localStorage.setItem(TUTORIAL_BACKUP, JSON.stringify(workspace.snapshot()));
    } catch {}
    try {
      await workspace.apply({ name: "入门练习", files: {}, data: {}, folders: [] });
      $("modal").close();
      setSideTab("files");
      tutorial.start();
    } catch (e) {
      notify(e.message);
    }
  };
};
document.addEventListener("click", (e) => {
  if (tutorial.active && e.target.closest("#download-zip, #download-json")) {
    tutorial.memo.exported = true;
    setTimeout(() => tutorial.update());
  }
});
function openPicker(prefix = "") {
  const commands = commandList();
  modal(
    prefix === ">" ? "命令面板" : "快速打开",
    `<input id="picker-input" aria-label="搜索" autocomplete="off" style="width:100%"><div id="picker-list" role="listbox"></div><p class="muted picker-help">文件或标签名 · @ 当前文件符号 · :行号 · 文件:行号 · 0x 地址 · > 命令 · ? 查指令与用途</p>`,
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
    // "?" switches to the instruction and purpose search.
    if (input.value.startsWith("?") || input.value.startsWith("？"))
      return findInstruction(input.value.slice(1));
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
$("demo").onclick = () => (running ? requestStop() : run("demo"));
$("back").onclick = () =>
  command("back").then(() => {
    followPC();
    arrive();
  });
for (let mode of ["source", "over", "out", "run"])
  $(mode).onclick = () =>
    mode === "run" && running ? requestStop() : mode === "run" && canRestart() ? restartRun() : run(mode);
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
    `<div class="radix-help"><p class="radix-example">同一个数的几种写法：${["dec", "hex", "bin", "ascii"].map((m) => `<code>${esc(formatValue(104, { radix: m, width: 1, kind: "bits" }).text)}</code>`).join(" = ")}</p>${RADIXES.map(([v, l]) => `<p><b>${l}</b> ${esc(RADIX_HELP[v].replace(/^[^：]+：/, ""))}</p>`).join("")}
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
  tutorial?.update();
}
$("focus-open").onclick = openFocus;
$("theme").onclick = () => {
  document.body.classList.toggle("dark");
  overlay.schedule();
};
// Code size steps up and down (trial feedback: A＋ only cycled back to the
// smallest size, so there was no way to step down), remembered per viewer.
function setFontSize(size) {
  fontSize = Math.max(11, Math.min(22, size));
  document.documentElement.style.setProperty("--code", fontSize + "px");
  $("zoom").title = `放大代码字号（当前 ${fontSize}）`;
  $("zoom-out").title = `缩小代码字号（当前 ${fontSize}）`;
  $("zoom").disabled = fontSize >= 22;
  $("zoom-out").disabled = fontSize <= 11;
  try {
    localStorage.setItem("code-size", String(fontSize));
  } catch {}
  editor.requestMeasure();
  overlay.schedule();
}
$("zoom").onclick = () => setFontSize(fontSize + 1);
// Panels resize by dragging the lines between them, or with the arrow keys
// on a focused line (2026-10-23 feedback). Sizes are remembered per viewer;
// a double-click restores the default.
const panelSplits = {
  "split-left": {
    prop: "--left-w",
    axis: "x",
    sign: 1,
    min: 180,
    panel: ".sidebar",
  },
  "split-right": {
    prop: "--right-w",
    axis: "x",
    sign: -1,
    min: 220,
    panel: ".inspector",
  },
  "split-bottom": {
    prop: "--bottom-h",
    axis: "y",
    sign: -1,
    min: 70,
    panel: ".bottom",
  },
  // Right-hand panels: the upper two have a height, memory takes the rest.
  "split-context": {
    prop: "--context-h",
    axis: "y",
    sign: 1,
    min: 60,
    panel: "#panel-context",
    max: () =>
      document.querySelector(".inspector").offsetHeight -
      document.querySelector("#panel-registers").offsetHeight -
      70,
  },
  "split-registers": {
    prop: "--registers-h",
    axis: "y",
    sign: 1,
    min: 60,
    panel: "#panel-registers",
    max: () =>
      document.querySelector(".inspector").offsetHeight -
      document.querySelector("#panel-context").offsetHeight -
      70,
  },
};
function setSplit({ prop, axis, min, panel, max: limit }, px) {
  const root = document.documentElement;
  if (px == null) root.style.removeProperty(prop);
  else {
    // Leave the code pane usable: at least 300px wide and 160px tall.
    const max = limit
      ? limit()
      : axis === "x"
        ? document.querySelector(".workspace").offsetWidth -
          document.querySelector(
            prop === "--left-w" ? ".inspector" : ".sidebar",
          ).offsetWidth -
          300
        : document.querySelector(".code-pane").offsetHeight - 160;
    px = Math.round(Math.max(min, Math.min(max, px)));
    root.style.setProperty(prop, px + "px");
  }
  try {
    if (px == null) localStorage.removeItem("split" + prop);
    else localStorage.setItem("split" + prop, String(px));
  } catch {}
  editor.requestMeasure();
  overlay.schedule();
}
for (const [id, split] of Object.entries(panelSplits)) {
  const line = $(id),
    size = () =>
      document.querySelector(split.panel).getBoundingClientRect()[
        split.axis === "x" ? "width" : "height"
      ];
  try {
    const saved = Number(localStorage.getItem("split" + split.prop));
    if (saved) setSplit(split, saved);
  } catch {}
  line.addEventListener("pointerdown", (down) => {
    if (down.button !== 0) return;
    down.preventDefault();
    line.setPointerCapture(down.pointerId);
    line.classList.add("dragging");
    document.body.classList.add("resizing-" + split.axis);
    const at = (e) => (split.axis === "x" ? e.clientX : e.clientY),
      start = at(down),
      from = size();
    const move = (e) => setSplit(split, from + split.sign * (at(e) - start));
    const end = () => {
      line.removeEventListener("pointermove", move);
      line.removeEventListener("pointerup", end);
      line.removeEventListener("pointercancel", end);
      line.classList.remove("dragging");
      document.body.classList.remove("resizing-" + split.axis);
    };
    line.addEventListener("pointermove", move);
    line.addEventListener("pointerup", end);
    line.addEventListener("pointercancel", end);
  });
  line.addEventListener("dblclick", () => setSplit(split, null));
  line.addEventListener("keydown", (e) => {
    const keys =
      split.axis === "x"
        ? { ArrowLeft: -1, ArrowRight: 1 }
        : { ArrowUp: -1, ArrowDown: 1 };
    if (!(e.key in keys)) return;
    e.preventDefault();
    e.stopPropagation();
    setSplit(split, size() + split.sign * keys[e.key] * 16);
  });
}
$("zoom-out").onclick = () => setFontSize(fontSize - 1);
try {
  const saved = Number(localStorage.getItem("code-size"));
  if (saved) setFontSize(saved);
} catch {}
$("clear-focus").onclick = () => {
  focus = null;
  inspecting = null;
  inspectingPlace = null;
  following = true;
  showContext(CONTEXT_HINT);
  followInspector();
  renderRegisters();
  overlay.schedule();
};
$("reg-filter").onchange = () => {
  renderRegisters();
  overlay.schedule();
};
$("symbol-search").oninput = renderSymbols;
$("delay").onchange = () => {
  workspace?.changed();
  dirty = true;
  notify("运行配置已修改，请重新汇编");
  updateControls();
};
for (let id of ["solid", "dashed", "reads", "writes", "flows"])
  $(id).onchange = () => overlay.schedule();
document
  .querySelectorAll("[data-view]")
  .forEach((b) => (b.onclick = () => setView(b.dataset.view)));
document.querySelectorAll("[data-bottom]").forEach(
  (b) =>
    (b.onclick = () => {
      problemsShownForError = false;
      setBottom(b.dataset.bottom);
    }),
);
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
$("example").onchange = () => {
  if ($("example").value !== "") loadExample(Number($("example").value));
  $("example").value = "";
};
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
  pause: () => requestStop(),
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
  const p = exampleList[index];
  if (p) workspace.example(p, p.name);
}
function selectActiveFile(name) {
  if (name) { switchFile(name); return; }
  savedEditor();
  activeFile = "";
  loadEditor = true;
  editor.dispatch({changes:{from:0,to:editor.state.doc.length,insert:""}, effects:fileAccess.reconfigure([EditorState.readOnly.of(true), EditorView.editable.of(false)])});
  loadEditor = false;
  renderTabs();
  overlay.schedule();
}
workspace = projectManager({
  snapshot: () => { savedEditor(); return {files, data, activeFile, delay:$("delay").checked}; },
  busy: () => busy || running,
  openFile: name => {setView("source");switchFile(name);editor.focus();},
  selectActive: name => { selectActiveFile(name); renderTabs(); },
  modal, notify, editData, assemble,
  scopeChanged: () => updateControls(),
  replace: async p => {
    await requestStop();
    if (busy) throw Error("请等待当前操作完成。");
    lens.close();
    lens.update(null);
    activeFile = "";
    files = {...p.files}; data = {...p.data};
    fileStates.clear(); navBack.length = navForward.length = 0;
    breakpoints = []; watches = []; debugLog = [];
    state = null; program = {instructions:[], symbols:[], instructionDocs:{}};
    target = null; lastInTarget = ""; inspectingPlace = null; following = true;
    showContext(CONTEXT_HINT);
    inspecting = null; focus = null; inlineCache.key = null;
    dirty = true; pendingResume = null;
    $("delay").checked = p.delay;
    setView("source"); setBottom("console");
    for (const id of ["output","trace","calls","problems","logs","symbols","registers","memory","machine","cfg"]) {
      if ($(id)) $(id).replaceChildren();
    }
    $("last-card").innerHTML='<small>刚完成 · 实线</small><b>尚无执行记录</b>';
    $("next-card").innerHTML='<small>下一条 · 虚线</small><b>汇编后开始</b>';
    $("location").textContent="尚未汇编";
    $("history-info").textContent="0 / 0 步";
    $("pc").textContent="PC —";
    selectActiveFile(p.activeFile);
    renderFiles(); renderTabs(); renderStops(); updateControls();
    notify("工程已更新 · 点击“汇编”开始执行。");
  },
});
await workspace.start();
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

// Examples are optional; editing and local draft recovery work without the backend.
(async () => {
try {
  const response = await fetch("/examples");
  if (!response.ok) throw Error("示例服务暂时不可用");
  exampleList = await response.json();
  $("example").innerHTML = '<option value="">教学示例…</option>' + exampleList.map((e,i) =>
    `<option value="${i}">${esc(e.name === "hexout" ? "Hexadecimal · 位与字符" : e.name === "task1" ? "Task 1 · 文件与调用" : e.name)}</option>`
  ).join('');
} catch (e) {
  $("example").innerHTML='<option value="">示例暂不可用</option>';
}
})();
