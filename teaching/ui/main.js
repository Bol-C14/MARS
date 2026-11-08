import { t, LANGUAGES, localized, language, setLanguage, onLanguageChange, applyDom } from "./i18n/index.js";
import { marsText } from "./i18n/mars.js";
import {
  EditorView,
  Decoration,
  ViewPlugin,
  GutterMarker,
  WidgetType,
  gutter,
  gutterLineClass,
  keymap,
} from "@codemirror/view";
import { EditorState, RangeSet, StateEffect, StateField, Compartment, Transaction } from "@codemirror/state";
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
  bitDots,
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
import { assemblyScope, scopeHints, pathName } from "./workspace.js";
import { put, get, drop } from "./store.js";
import { liveCheck } from "./live-check.js";
import { parseAddress, dataSymbols, memoryRows, wordValue, memoryBar, barPosition } from "./memory-view.js";
const $ = (id) => document.getElementById(id);
// Joining words: 、 and ： in Chinese, ", " and ": " in English.
const LIST_SEP = () => t("common.listSep");
const COLON = () => t("common.colon");
let chordNote = "";
// Jumps and branches take VS Code's control-keyword colour, the same purple
// as control-flow arrows.
const CONTROL_OPS =
  /^(?:j|jal|jr|jalr|b|beq|bne|bgez|bgtz|blez|bltz|bgezal|bltzal|blt|bgt|ble|bge|bltu|bgtu|bleu|bgeu|beqz|bnez)$/;
// A Chinese description of an instruction: the hand-written explanation,
// else the purpose and limits from the instruction search table, and only
// then MARS's English text (round-4 trial: sub showed "Subtraction with
// overflow"). One table serves search, hover and the inspector.
const CURATED = localized(() => new Map(
  instructionIndex({})
    .filter((x) => x.kind === "instruction")
    .map((x) => [x.op, x]),
));
function zhDoc(op) {
  if (explanations[op]) return explanations[op];
  const c = CURATED.get(op);
  return c ? `${c.purpose}${c.note ? t("common.semicolon") + c.note : ""}${t("common.period")}` : "";
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
  lastSourceFile = "",
  runtimeFiles = {},
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
      e.title = t("breakpoint.outsideScope");
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
const DELAY_NOP = () =>
  t("editor.delaySlot");
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
      if (!Object.hasOwn(files, activeFile)) return Decoration.none;
      const currentExecution = !dirty && target?.sources?.[activeFile] === v.state.doc.toString();
      let ranges = [];
      for (let { from, to } of v.visibleRanges) {
        for (let pos = from; pos <= to;) {
          let l = v.state.doc.lineAt(pos);
          let cls = [];
          if (
            currentExecution &&
            state?.last?.instruction?.file === activeFile &&
            state.last.instruction.line === l.number
          )
            cls.push("last-line");
          if (
            currentExecution &&
            state?.preview?.instruction?.file === activeFile &&
            state.preview.instruction.line === l.number
          )
            cls.push("next-line");
          const slot = currentExecution && delaySlots().has(activeFile + ":" + l.number);
          if (slot) cls.push("delay-nop");
          if (cls.length)
            ranges.push(
              Decoration.line({
                class: cls.join(" "),
                attributes: slot ? { title: DELAY_NOP() } : {},
              }).range(l.from),
            );
          const inline = currentExecution && inlineValues().get(activeFile + ":" + l.number);
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
      `<div class="cm-peek-head"><b>${esc(token)}</b> ${t("peek.count", { count: refs.length })}<button data-peek-close aria-label="${t("common.close")}">×</button></div>` +
      (refs.length
        ? refs
            .map(
              (r, i) =>
                `<button class="cm-peek-row" data-peek="${i}"><span>${esc(r.file)}:${r.line}</span><small>${esc(r.type)}</small><code>${esc(r.text.trim())}</code></button>`,
            )
            .join("")
        : `<p class="muted">${t("peek.none")}</p>`);
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
      t("editor.menu.runToLine"),
      canRun && address != null,
      () => run("run", { breakpoints: [...activeBreakpoints(), { address }] }),
    ],
    [t("editor.menu.toggleBreakpoint"), address != null, () => toggleBreakpoint(line), "breakpoint"],
    [t("editor.menu.editBreakpoint"), address != null, () => editBreakpoint(address)],
    [t("editor.menu.definition"), true, () => openDetail(pos)],
    [t("editor.menu.references"), !!token, () => peekReferences()],
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
// Assembly errors drawn on the code. They stay with their text while the
// student edits elsewhere and go when that text changes: the error is then
// no longer known, until the next assembly checks it again.
const setErrorMarks = StateEffect.define();
const errorField = StateField.define({
  create: () => Decoration.none,
  update(marks, tr) {
    if (tr.docChanged) {
      const touched = [];
      tr.changes.iterChangedRanges((_a, _b, from, to) => touched.push([from, to]));
      marks = marks
        .map(tr.changes)
        .update({ filter: (from, to) => !touched.some(([a, b]) => a <= to && b >= from) });
    }
    for (const e of tr.effects) if (e.is(setErrorMarks)) marks = e.value;
    return marks;
  },
  provide: (f) => EditorView.decorations.from(f),
});
class ErrorLine extends GutterMarker {
  constructor(warning) {
    super();
    this.elementClass = warning ? "warning-gutter" : "error-gutter";
  }
}
const errorLines = gutterLineClass.compute([errorField], (s) => {
  const lines = new Map();
  s.field(errorField).between(0, s.doc.length, (from, _to, mark) => {
    const at = s.doc.lineAt(from).from;
    lines.set(at, lines.get(at) === false ? false : mark.spec.warning);
  });
  return RangeSet.of([...lines].map(([at, warning]) => new ErrorLine(warning).range(at)), true);
});
// The diagnostics of the last assembly, and the text they were found in.
let errorReport = { list: [], sources: {} };
// A diagnostic marks the word MARS points at, or the code on the line when
// its column says nothing.
function errorRange(doc, d) {
  if (d.line < 1 || d.line > doc.lines) return null;
  const line = doc.line(d.line),
    code = line.text.replace(/\s*#.*$/, "");
  const start = d.column > 0 && d.column <= code.length ? d.column - 1 : code.search(/\S/);
  if (start < 0) return null;
  const word = /^[^\s,()]+/.exec(code.slice(start))?.[0].length || code.length - start;
  return { from: line.from + start, to: line.from + start + word };
}
// Drawn only on the text the assembler saw: positions mean nothing elsewhere.
function drawErrors() {
  const marks = [];
  if (activeFile && errorReport.sources[activeFile] === editor.state.doc.toString())
    for (const d of errorReport.list.filter((d) => d.file === activeFile)) {
      const r = errorRange(editor.state.doc, d);
      if (r)
        marks.push(
          Decoration.mark({ class: d.warning ? "cm-warning-mark" : "cm-error-mark", message: marsText(d.message), warning: d.warning }).range(r.from, r.to),
        );
    }
  editor.dispatch({ effects: setErrorMarks.of(Decoration.set(marks, true)) });
}
// Line checks add to what is shown: only the lines they looked at change.
function showLineProblems(lines, list) {
  const doc = editor.state.doc,
    looked = new Set(lines),
    kept = [];
  editor.state.field(errorField).between(0, doc.length, (from, to, mark) => {
    if (!mark.spec.live || !looked.has(doc.lineAt(from).number)) kept.push(mark.range(from, to));
  });
  for (const d of list) {
    const r = errorRange(doc, d);
    if (r && !kept.some((k) => k.from === r.from))
      kept.push(Decoration.mark({ class: "cm-error-mark", message: marsText(d.message), warning: false, live: true }).range(r.from, r.to));
  }
  editor.dispatch({ effects: setErrorMarks.of(Decoration.set(kept, true)) });
}
const live = liveCheck({
  post: async (body) => {
    const r = await fetch("/api/check", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if ([404, 405, 501].includes(r.status)) return null;
    if (!r.ok) return undefined;
    const reply = await r.json().catch(() => null);
    return reply?.protocol === 1 ? reply : null;
  },
  current: () => ({ file: activeFile, doc: editor.state.doc }),
  scope: () => {
    const s = nextScope();
    return s.error ? null : { files: Object.fromEntries(s.files.map((n) => [n, files[n]])), entry: s.entry, delay: $("delay").checked };
  },
  ready: () => !running && !busy,
  held: () => {
    let found = false;
    editor.state.field(errorField).between(0, editor.state.doc.length, (_f, _t, mark) => {
      if (mark.spec.live) found = true;
    });
    return found;
  },
  showLines: showLineProblems,
  showScope: (list, sources) => {
    errorReport = { list, sources };
    drawErrors();
    renderFiles();
  },
});
function errorAt(pos) {
  let message = "";
  editor.state.field(errorField).between(pos, pos, (_from, _to, mark) => {
    message = mark.spec.message;
  });
  return message;
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
  if (!Object.hasOwn(files, activeFile)) return null;
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
      errorField,
      errorLines,
      EditorView.updateListener.of((u) => {
        if (u.docChanged && !loadEditor) {
          clearTimeout(arrive.timer);
          arrive.pulse?.cancel();
          editor.dom.classList.remove("arrival-spotlight");
          if (!activeFile) return;
          const source = Object.hasOwn(files, activeFile);
          if (!source && !Object.hasOwn(data, activeFile)) return;
          (source ? files : data)[activeFile] = u.state.doc.toString();
          if (source) live.edited(u.changes);
          workspace?.changed();
          renderTabs();
          // A text file is read only when assembling: the paused program keeps
          // the contents it was assembled with, so debugging goes on
          // (classroom 2026-11-04: editing an output file locked the controls).
          if (!source) {
            $("banner").textContent = t("banner.inputChanged");
            $("banner").className = "visible";
          } else if (!target || target.files.includes(activeFile)) {
            dirty = true;
            $("banner").textContent = t("banner.sourceChanged");
            $("banner").className = "visible";
          }
          updateControls();
        }
        overlay?.schedule();
      }),
      EditorView.domEventHandlers({
        mousemove: (e) => e.buttons ? hideTooltip(0) : hover(e),
        mouseleave: () => hideTooltip(),
        // Touch has no hover: a tap shows the same note, with its button.
        pointerdown: (e) => {
          if (e.pointerType === "touch") {
            tipFor = "";
            hover(e);
          } else hideTooltip(0);
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
const emptyEditorState = editor.state;
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
  return `<div class="values"><span>hex</span><span>${hex(v)}</span><span>signed</span><span>${v}</span><span>unsigned</span><span>${v >>> 0}</span><span>bits</span><span class="bits">${(v >>> 0).toString(2).padStart(32, "0").match(/.{4}/g).join(" ")}</span><span>${t("tip.asciiLow")}</span><span>${c >= 32 && c < 127 ? esc(String.fromCharCode(c)) : c === 0 ? "NUL" : t("tip.notPrintable")} (${c})</span></div>`;
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
      ? (state.preview.accesses.find((a) => a.kind === "register" && !a.write && a.name === r)?.value ?? state.registers.find((a) => a.name === r)?.value ?? null)
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
  return u ? `<p class="tip-formula">${t("tip.syntax")}<code>${esc(u.format)}</code></p>` : "";
};
const isNumber = (token) => /^-?(?:0x[\da-f]+|\d+)$/i.test(token);
function summary(token, line = "", place = null) {
  token = canonicalReg(token);
  if (token.startsWith("$"))
    return `<b>${esc(token)}</b> ${esc(fmt(regValue(token), 4, regKind(token)).text)}<p>${esc(role(token))}</p><small>${t("tip.valueAfter", { step: state?.step ?? 0 })}</small>`;
  if (token === "syscall") {
    const at = syscallAt(place),
      g = serviceGuide[at.n];
    return `<b>${esc(at.n == null ? t("tip.syscallUnknown") : `syscall${COLON()}${g ? g[0] : t("tip.unsupported")}${t("common.inParens", { text: `$v0 = ${at.n}` })}`)}</b><p>${esc(g ? g[1] : t("tip.syscallLater"))}</p>${at.setter ? `<small>${t("tip.syscallSetter", { line: at.setter.line, code: esc(at.setter.text) })}</small>` : ""}`;
  }
  if (zhDoc(token)) {
    const text = zhDoc(token);
    return `<b>${esc(token)}</b><p>${esc(text)}</p>${tipUsage(token)}${lineFormula(place)}<small>${t("tip.instructionDoc")}</small>`;
  }
  if (directiveGuide[token])
    return `<b>${esc(token)}</b><p>${esc(directiveGuide[token][1])}</p><p class="tip-formula">${t("tip.syntax")}<code>${esc(directiveGuide[token][0])}</code></p><small>${t("tip.directive")}</small>`;
  if (isNumber(token)) return `<b>${esc(token)}</b><p>${t("tip.constant")}</p>`;
  if (program.instructionDocs[token]) {
    const doc = program.instructionDocs[token],
      mars = withOperands(doc.description, doc.example, line);
    return `<b>${esc(token)}</b><p>${esc(mars.text)}</p>${lineFormula(place)}<small>${t("tip.marsOriginal", { example: mars.substituted ? t("tip.marsSubstituted") : t("tip.marsExample", { example: esc(doc.example) }) })}</small>`;
  }
  let symbol = program.symbols.find((s) => s.name === token);
  if (symbol)
    return `<b>${esc(token)}</b><p>${t("tip.symbolAddress", { address: hex(symbol.address) })}</p><small>${t("tip.symbolJump", { keys: DETAIL_KEYS() })}</small>`;
  return `<b>${esc(token)}</b><p>${t("tip.label")}</p>`;
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
const DETAIL_KEYS = () => IS_MAC ? t("keys.detailMac") : t("keys.detail");
const DETAIL_HINT = () => t("tip.detailHint", { keys: DETAIL_KEYS() });
let tipFor = "",
  tipHide = null;
function cancelTooltipHide() {
  clearTimeout(tipHide);
  tipHide = null;
}
function hideTooltip(delay = 100) {
  const close = () => {
    $("tooltip").hidden = true;
    tipFor = "";
    tipHide = null;
  };
  if (delay === 0) {
    cancelTooltipHide();
    close();
  } else if (tipHide === null) {
    // Blank-space mousemoves must not keep postponing dismissal.
    tipHide = setTimeout(close, delay);
  }
}
for (const event of ["keydown", "beforeinput", "compositionstart"])
  editor.dom.addEventListener(event, () => hideTooltip(0), true);
editor.scrollDOM.addEventListener("scroll", () => {
  hideTooltip(0);
  requestAnimationFrame(updateReturn);
});
for (const event of ["wheel", "touchmove", "pointerdown"])
  editor.scrollDOM.addEventListener(event, leftExecution, { passive: true });
editor.dom.addEventListener("keydown", leftExecution, true);
$("follow-return").onclick = () => {
  followHold = 0;
  const ins = executionInstruction();
  if (!ins) return;
  autoMoving = true;
  try {
    gotoSource(ins.file, ins.line, false);
  } finally {
    autoMoving = false;
  }
  arrive(true);
  requestAnimationFrame(updateReturn);
};
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
  if (!Object.hasOwn(files, activeFile)) return hideTooltip(0);
  const at = pointedPos(e),
    pos = at?.pos,
    token = !at || at.past ? "" : tokenAt(pos),
    problem = !at || at.past ? "" : errorAt(pos);
  if (!token && !problem) return hideTooltip();
  const line = editor.state.doc.lineAt(pos),
    place = { file: activeFile, line: line.number },
    key = `${token}@${activeFile}:${line.number}`;
  cancelTooltipHide();
  if (key === tipFor && !$("tooltip").hidden) return;
  tipFor = key;
  const report = problem ? `<div class="tip-error" role="alert">${esc(problem)}</div>` : "";
  $("tooltip").innerHTML = token
    ? `${report}<div class="tip-hint">${DETAIL_HINT()}</div>${summary(token, line.text, place)}<button class="tip-detail" type="button">${t("tip.detailButton")}</button>`
    : report;
  if (token)
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
    go.textContent = t("inspector.asAddress");
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
  if (!Object.hasOwn(files, activeFile)) return;
  const line = editor.state.doc.lineAt(pos),
    place = { file: activeFile, line: line.number };
  const word = line.text
    .replace(/#.*/, "")
    .replace(/^\s*(?:[\w.$]+:\s*)*/, "")
    .trim()
    .split(/\s+/)[0];
  const token = (past ? "" : tokenAt(pos)) || word;
  if (!token) return notify(t("inspector.noInstruction"), { transient: true });
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
$("tooltip").addEventListener("mouseenter", cancelTooltipHide);
$("tooltip").addEventListener("mouseleave", () => hideTooltip());
const CONTEXT_HINT = () => `<p class="muted">${t("inspector.empty", { keys: DETAIL_KEYS() })}</p>`;
// The inspector follows execution by default, showing the line that just
// ran (or, before anything ran, the next one as a preview); opening an object
// pins it until "回到跟随执行" or "取消固定" (round-4 trial: a pinned syscall
// from line 36 was read as describing the current line 11).
function followInspector() {
  if (!following || !state || dirty || running) return;
  const e = state.last?.instruction ? state.last : state.preview,
    ins = e?.instruction;
  if (!ins) return showContext(CONTEXT_HINT());
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
      ? `<div class="inspect-mode">${t("inspector.following", { when: state.last?.instruction ? t("inspector.following.done") : t("inspector.following.next"), line: e.instruction.line })}</div>`
      : "";
  }
  if (!inspecting) return "";
  const pinned = inspectingPlace ? `${inspectingPlace.file}:${inspectingPlace.line}` : "";
  const here = program.instructions.find((i) => i.address === executionPC());
  const away =
    pinned && here && ![at(state.last), at(state.preview)].includes(pinned);
  return `<div class="inspect-mode pinned">${t("inspector.pinned", { item: esc(inspecting), line: inspectingPlace ? ` ${t("inspector.pinned.line", { line: inspectingPlace.line })}` : "", away: away ? ` ${t("inspector.pinned.away", { line: here.line })}` : "" })}<button id="follow-again">${t("inspector.followAgain")}</button></div>`;
}
// Actions people miss at the bottom of a long detail sit as icons in the
// panel's title row, beside 取消固定 (classroom 2026-11-03).
const CONTEXT_ICONS = {
  // The same mark as the return-to-execution button: go to a line.
  "detail-source": '<circle cx="8" cy="8" r="2.2"/><path d="M8 1.5v2.5M8 12v2.5M1.5 8H4M12 8h2.5"/><circle cx="8" cy="8" r="5"/>',
  refs: '<circle cx="4" cy="11" r="2.5"/><circle cx="12" cy="11" r="2.5"/><path d="M6.5 11h3M2.5 9 4.5 3.5h2L7 9M13.5 9 11.5 3.5h-2L9 9"/>',
  "detail-bits": '<path d="M2 5.5V2h3.5M10.5 2H14v3.5M14 10.5V14h-3.5M5.5 14H2v-3.5"/><circle cx="8" cy="8" r="2.5"/>',
};
function showContext(html) {
  $("context").innerHTML = modeBar() + html;
  const tools = $("context-tools");
  tools.replaceChildren();
  for (const [id, icon] of Object.entries(CONTEXT_ICONS)) {
    const b = $("context").querySelector("#" + id);
    if (!b) continue;
    const name = b.textContent.trim();
    b.classList.add("tool");
    b.dataset.tip = name;
    b.setAttribute("aria-label", name);
    b.innerHTML = `<svg viewBox="0 0 16 16" aria-hidden="true">${icon}</svg><span class="tool-label">${esc(name)}</span>`;
    tools.append(b);
  }
  $("context").querySelectorAll(".context-actions:empty").forEach((e) => e.remove());
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
      `<h3>${esc(token)}</h3><p>${t("inspector.addressAfter", { step: state?.step ?? 0 })}</p><div class="values"><span>${t("inspector.address.base")}</span><span>${esc(address[2])} = ${hex(base)}</span><span>${t("inspector.address.offset")}</span><span>${t("inspector.address.bytes", { offset })}</span><span>${t("common.address")}</span><span>${hex(effective)}</span></div><button id="inspect-memory">${t("inspector.viewMemory")}</button>`,
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
      `<h3>${esc(token)} <small class="muted">${t("inspector.register")}</small></h3><p>${esc(role(token))}</p>${valueHTML(value)}<p class="muted">${t("inspector.register.value", { step: state?.step ?? 0, lastWrite: last ? t("inspector.lastWriteAt", { last }) : t("inspector.neverWritten") })}</p><div class="context-actions"><button id="refs">${t("inspector.references")}</button><button id="pin">${pinned.has(token) ? t("inspector.unpin") : t("inspector.pin")}</button><button id="point">${t("inspector.asAddress")}</button><button id="last-write" ${last ? "" : "disabled"}>${t("inspector.lastWrite")}</button><button id="next-write">${t("inspector.runToWrite")}</button></div>`,
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
      detail = syscallDetail({ ...at, regTitle: (r) => r + COLON() + role(r) }),
      words = t("inspector.syscall.terms", { words: (serviceGuide[at.n] || []).flat(2).join(" ") });
    showContext(
      `<h3>${esc(detail.title)}</h3>${detail.html}${termsIn(words).length ? `<details class="detail-terms"><summary>${t("common.terms")}</summary>${definitions(words)}</details>` : ""}<div class="context-actions">${at.n === 11 || at.n === 12 ? `<button id="char-table">${t("inspector.charTable")}</button>` : ""}<button id="service-list">${t("inspector.syscall.services")}</button></div>`,
    );
    if ($("char-table")) $("char-table").onclick = () => $("radix-help").click();
    $("service-list").onclick = () =>
      modal(
        t("inspector.syscall.title"),
        Object.entries(services)
          .map(
            ([id, s]) =>
              `<p><b>$v0 = ${id}</b> ${serviceGuide[id]?.[0] || s[0]} · ${serviceGuide[id]?.[1] || ""} <small class="muted">${t("inspector.syscall.args", { args: s[1].join(", ") || t("common.none"), result: s[2].join(", ") || t("inspector.syscall.noResult") })}</small></p>`,
          )
          .join(""),
      );
    return;
  }
  let symbol = program.symbols.find((s) => s.name === token);
  if (symbol) {
    showContext(
      `<h3>${esc(token)}</h3><p>${t("inspector.symbol.address")} <code>${hex(symbol.address)}</code></p><div class="context-actions"><button id="definition">${t("inspector.symbol.definition")}</button><button id="symbol-memory">${t("inspector.symbol.memory")}</button><button id="refs">${t("inspector.symbol.references")}</button></div>`,
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
      `<h3>${esc(token)} <small class="muted">${t("inspector.directive")}</small></h3><p>${esc(does)}</p><dl class="detail-steps"><dt>${t("common.syntax")}</dt><dd><code>${esc(written)}</code></dd></dl><p class="muted">${t("inspector.directive.note")}</p>`,
    );
    return;
  }
  if (isNumber(token)) {
    showContext(`<h3>${esc(token)} <small class="muted">${t("inspector.constant")}</small></h3><p>${t("inspector.constant.note")}</p>${valueHTML(Number(token))}`);
    return;
  }
  const known = zhDoc(token) || program.instructionDocs[token]?.description,
    u = isInstruction(token) ? usage(token) : null;
  showContext(
    `<h3>${esc(token)}</h3><p>${esc(known || t("inspector.label"))}</p>${u ? usageRows(u) : ""}<div class="context-actions"><button id="refs">${t("inspector.references")}</button></div>`,
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
    return `<li><code>${esc(p.name)}</code>${p.value ? ` = <code>${esc(p.value)}</code>` : ""} ${esc(line ? p.meaning.replace(/（.*）$/, "") : p.meaning)}${line ? `<small>${t("inspector.lineRef", { line })}</small>` : ""}</li>`;
  };
  const written = u.parts.some((p) => p.value);
  return `<dl class="detail-steps"><dt>${t("common.syntax")}</dt><dd><code>${esc(u.format)}</code>${u.parts.length ? `<ul class="usage-parts">${u.parts.map(part).join("")}</ul>` : ""}</dd>${u.formula ? `<dt>${t("inspector.rule")}</dt><dd><code>${esc(u.formula)}</code></dd>` : ""}${!written && u.example && u.example !== u.format ? `<dt>${t("common.example")}</dt><dd><code>${esc(u.example)}</code></dd>` : ""}</dl>`;
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
  const formula = lineTemplate(place);
  return formula ? `<p class="tip-formula">${t("inspector.thisLine")}<code>${esc(plainEq(formula))}</code></p>` : "";
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
    ? t("inspector.stale")
    : !state
      ? t("status.notAssembledYet")
      : !run
        ? t("inspector.notReached")
        : run.kind === "last"
          ? t("inspector.justRun", { step: run.step })
          : run.kind === "next"
            ? t("inspector.preview")
            : t("inspector.ranAt", { step: run.step });
  const value = (o, v) =>
    fmt(v, o.width || 4, o.kind === "memory" ? "bits" : regKind(o.name)).text;
  const label = (o) => (o.kind === "memory" ? t("inspector.memoryCell", { address: hex(o.address) }) : o.name);
  // Register names can be hovered for their conventional use.
  const labelHTML = (o) =>
    o.kind === "memory"
      ? esc(label(o))
      : `<abbr class="reg-term" title="${esc(o.name + COLON() + role(o.name))}">${esc(o.name)}</abbr>`;
  const reads = (model?.objects || []).filter((o) => o.read),
    writes = (model?.objects || []).filter((o) => o.write);
  const single = (template && !(run?.events?.length > 1) && !run?.pseudo);
  const written = usage(token, source);
  const bitsEvent = (run?.events || []).find(supportsBits);
  const rows = [];
  if (template && single && !written?.formula)
    rows.push([t("inspector.rule"), `<code>${esc(genericTemplate(template, source))}</code>`]);
  if (template)
    rows.push([t("inspector.substituted"), `<code>${esc(plainEq(template))}</code>`]);
  if (model) {
    // A register both read and written: the right-hand side uses the value
    // from before the write (round-4 trial: students had to infer this).
    const both = writes.filter((w) => w.kind === "register" && reads.some((r) => r.name === w.name));
    rows.push([
      run.kind === "next" ? t("inspector.valuesBeforeNow") : t("inspector.valuesBefore"),
      (reads.length ? reads.map((o) => `${labelHTML(o)} = <b>${esc(value(o, o.before))}</b>`).join(t("common.comma")) : t("inspector.noReads")) +
        both.map((o) => `<small class="detail-when">${t("inspector.sameRegister", { reg: esc(o.name), before: esc(value(o, o.before)), after: esc(value(o, o.after)), reg: esc(o.name) })}</small>`).join(""),
    ]);
    rows.push([
      t("inspector.computation"),
      `<ol>${model.beats.map((b) => `<li><code>${esc(plainEq(b.eq))}</code>${b.caption ? ` <small>${esc(b.caption)}</small>` : ""}</li>`).join("")}</ol>`,
    ]);
    rows.push([
      t("inspector.valuesAfter"),
      (writes.length
        ? writes.map((o) => `${labelHTML(o)}${COLON()}${esc(value(o, o.before))} → <b>${esc(value(o, o.after))}</b>`).join("<br>")
        : esc(model.summary || t("inspector.noWrites"))) +
        `<small class="detail-when">${run.kind === "next" ? t("inspector.previewOnly") : t("inspector.actualResult")}</small>`,
    ]);
    const related = [
      reads.length && t("inspector.reads", { items: reads.map(labelHTML).join(LIST_SEP()) }),
      writes.length && t("inspector.writes", { items: writes.map(labelHTML).join(LIST_SEP()) }),
    ].filter(Boolean);
    if (related.length) rows.push([t("inspector.accesses"), related.join(" · ")]);
  } else if (run?.pseudo)
    rows.push([t("inspector.valuesAfter"), t("inspector.pseudo")]);
  showContext(
    `<div class="inspect-head"><h3>${esc(token)}</h3><span>${esc(where)} · ${esc(status)}</span></div><p>${esc(doc)}</p>${termsIn(doc).length ? `<details class="detail-terms"><summary>${t("common.terms")}</summary>${definitions(doc)}</details>` : ""}${written ? usageRows(written) : ""}${rows.length ? `<dl class="detail-steps">${rows.map(([t, d]) => `<dt>${t}</dt><dd>${d}</dd>`).join("")}</dl>` : ""}<div class="context-actions"><button id="detail-source">${t("inspector.locate")}</button><button id="refs">${t("inspector.references")}</button>${bitsEvent ? `<button id="detail-bits">${run.kind === "past" ? t("inspector.bitsPast") : t("inspector.bits")}</button>` : ""}</div>`,
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
    t("references.title", { token }),
    refs.length
      ? refs
          .map(
            (r, i) =>
              `<button class="command-item" data-ref="${i}"><b>${esc(r.file)}:${r.line}</b> <small>${r.type}</small><p class="mono">${esc(r.text)}</p></button>`,
          )
          .join("")
      : t("peek.none"),
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
    s = r.status === 413 ? { error: t("api.tooLarge") } : await r.json();
  if (!r.ok || !s.protocol) throw Error(s.error || t("api.noState"));
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
// Moving the memory window changes nothing in the program: it neither
// locks nor redraws the run controls (classroom 2026-11-05: scrolling memory
// made Assemble and the step buttons flicker). A newer command wins over a
// window request still on its way.
const QUIET = new Set(["memory"]);
let commandSerial = 0;
async function command(name, extra = {}) {
  if (busy) return null;
  if (EXECUTING.has(name) && blocked()) {
    notify(blocked(), { transient: true });
    return null;
  }
  const quiet = QUIET.has(name),
    serial = ++commandSerial;
  if (!quiet) {
    busy = true;
    updateControls();
  }
  try {
    let s = await api({
      command: name,
      programVersion: state?.programVersion,
      // The generated files already here: unchanged ones come back without contents.
      generatedKnown: runtimeFiles,
      ...lookahead(),
      ...extra,
    });
    if (quiet && serial !== commandSerial) return null;
    const before = state;
    state = s;
    syncRuntimeFiles(s);
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
    if (!quiet) {
      busy = false;
      updateControls();
    }
  }
}
async function assemble() {
  ++commandSerial;
  await requestStop();
  if (busy) return;
  busy = true;
  updateControls();
  try {
    savedEditor();
    if (!Object.keys(files).length) throw Error(t("assemble.noSource"));
    // Only the scope goes to the assembler: auto (main plus the files it
    // uses), the single open file, or the manual selection. Other exercises
    // stay in the tree (P0).
    const scope = nextScope();
    if (scope.error) throw Error(scope.error);
    runtimeFiles = {};
    const sourceFiles = Object.fromEntries(scope.files.map((n) => [n, files[n]]));
    state = await api({
      command: "assemble",
      files: sourceFiles,
      data,
      entry: scope.entry,
      delay: $("delay").checked,
      ...lookahead(),
    });
    live.reset();
    errorReport = {
      list: state.diagnostics || [],
      sources: sourceFiles,
    };
    drawErrors();
    renderFiles();
    target = { mode: scope.mode, files: [...scope.files], entry: scope.entry, sources: sourceFiles };
    lastInTarget = target.files.includes(activeFile) ? activeFile : target.entry;
    program = {
      instructions: state.instructions || [],
      symbols: state.symbols || [],
      instructionDocs: state.instructionDocs || {},
    };
    dirty = false;
    runMode = "";
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
  if (Object.hasOwn(files, activeFile)) files[activeFile] = editor.state.doc.toString();
  else if (Object.hasOwn(data, activeFile)) data[activeFile] = editor.state.doc.toString();
}
function switchFile(file) {
  if (!Object.hasOwn(files,file) && !Object.hasOwn(data,file)) return;
  if (!autoMoving) leftExecution();
  savedEditor();
  live.reset(); hideTooltip(0);
  if (activeFile) fileStates.set(activeFile, editor.state);
  activeFile = file;
  const source = Object.hasOwn(files,file);
  if (source) lastSourceFile = file;
  if (target?.files.includes(file)) lastInTarget = file;
  workspace?.opened(file);
  const text = source ? files[file] : data[file];
  const saved = fileStates.get(file);
  loadEditor = true;
  // Each document owns its undo stack; navigation is never an edit.
  const docState = saved?.doc.toString() === text ? saved : emptyEditorState.update({
    changes: { from: 0, to: emptyEditorState.doc.length, insert: text },
    annotations: Transaction.addToHistory.of(false),
  }).state;
  editor.setState(docState);
  loadEditor = false;
  drawErrors(); renderTabs(); renderFiles(); updateControls(); overlay.schedule();
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
  if (!place || (!Object.hasOwn(files,place.file) && !Object.hasOwn(data,place.file))) return;
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
  if (!Object.hasOwn(files,file) && !Object.hasOwn(data,file)) return;
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
    if (dirty || target?.sources?.[activeFile] !== editor.state.doc.toString()) return;
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
// During a step-by-step run the student may scroll or open another file for
// a moment; following resumes after FOLLOW_IDLE ms without such an action,
// or at once from the return button (classroom 2026-11-03).
const FOLLOW_IDLE = 4000;
let followHold = 0,
  autoMoving = false;
function leftExecution() {
  if (running && demoing) followHold = Date.now() + FOLLOW_IDLE;
  requestAnimationFrame(updateReturn);
}
function executionInstruction() {
  const ins = program.instructions.find((i) => i.address === executionPC());
  return ins && (!target || target.files.includes(ins.file)) ? ins : null;
}
// The return button shows whenever the executing line is out of sight.
function updateReturn() {
  const ins = state && !dirty && view === "source" ? executionInstruction() : null;
  let away = false;
  if (ins && ins.file !== activeFile) away = true;
  else if (ins) {
    const l = editor.state.doc.line(Math.min(ins.line, editor.state.doc.lines)),
      c = editor.coordsAtPos(l.from),
      r = editor.scrollDOM.getBoundingClientRect();
    away = !c || c.bottom < r.top || c.top > r.bottom;
  }
  $("follow-return").hidden = !away;
}
function followPC() {
  if (running && demoing && Date.now() < followHold) return updateReturn();
  autoMoving = true;
  try {
    movePC();
  } finally {
    autoMoving = false;
  }
  requestAnimationFrame(updateReturn);
}
function movePC() {
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
    notify(t("follow.entered", { file: ins.file, label: label ? " · " + label.name : "" }), {
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
  requestAnimationFrame(updateReturn);
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
      ? { file: i.file, line: i.line, text: t("common.fileLine", { file: i.file, line: i.line }) }
      : null;
  };
  // "Modified" only makes sense once a program was loaded (round-4 trial:
  // a fresh project already said its source had been modified).
  if (!target || !state || state.status === "empty")
    return { kind: "idle", text: t("status.start") };
  if (dirty) return { kind: "dirty", text: t("status.dirty") };
  if (running)
    return {
      kind: "running",
      text: stopRequested ? t("status.pausing") : t("status.running", { step: state.step }),
    };
  const next = where(state.pc),
    last = state.last ? where(state.last.pc) : null,
    reason = state.stopReason || "";
  if (state.status === "waiting")
    return {
      kind: "waiting",
      text: t("status.waiting"),
      at: next,
    };
  if (state.status === "ended")
    return { kind: "ended", text: t("status.ended", { exitCode: state.exitCode }), at: last };
  if (state.status === "error")
    return {
      kind: "error",
      text: t("status.error", { message: marsText(state.error).split("\n")[0].slice(0, 80) }),
      at: last,
    };
  if (reason.startsWith("Breakpoint") && next)
    return {
      kind: "breakpoint",
      text: t("status.breakpoint", { where: next.text, visits: state.pcVisits }),
      at: next,
    };
  if (reason.startsWith("Watchpoint") && last)
    return {
      kind: "breakpoint",
      text: t("status.watchpoint", { where: last.text, access: reason.endsWith("read") ? t("status.watchpoint.read") : t("status.watchpoint.write") }),
      at: last,
    };
  if (reason.startsWith("History limit"))
    return { kind: "error", text: t("status.historyLimit") };
  if (reason.startsWith("History"))
    return {
      kind: "paused",
      text: t("status.replay", { step: state.step, total: state.historyLength }),
      at: next,
    };
  if (!state.step && next)
    return { kind: "paused", text: t("status.ready", { where: next.text }), at: next };
  return {
    kind: "paused",
    text: last ? t("status.paused.after", { where: last.text }) : t("status.paused"),
    at: next,
  };
}
// Why execution buttons are unavailable, in the student's words (round-4
// trial: a grey run button did not say whether the program had ended or the
// open file was not the loaded one).
function executionBlock() {
  if (busy) return t("block.busy");
  if (running) return t("block.running");
  if (!state || state.status === "empty" || !target) return t("block.notAssembled");
  if (dirty) return t("block.dirty");
  const reason = scopeReason();
  if (reason?.kind === "outside") return t("block.outside", { file: activeFile });
  if (reason) return t("block.scopeChanged");
  if (state.status === "ended") return t("block.ended");
  if (state.status === "error") return t("block.error");
  return "";
}
// After the program ends, F5 starts it again from the beginning: the
// loaded program is assembled anew (breakpoints follow their file:line, and
// input is asked for again rather than replayed) and then run.
const canRestart = () =>
  state?.status === "ended" && !busy && !running && !dirty && !blocked();
async function restartRun() {
  await assemble();
  if (state?.status === "paused" && !state.error) await run("run");
}
// Once anything has run, the first button goes back to the start: the loaded
// program is assembled anew, so edits are picked up and input is asked again.
const started = () => running || !!state?.step || ["ended", "error"].includes(state?.status);
async function backToStart() {
  await requestStop();
  await assemble();
  followPC();
  arrive(true);
}
const RUN_ICONS = {
  full: '<path d="M1.5 3.5 7.5 8l-6 4.5zM8 3.5 14 8l-6 4.5z"/>',
  steps: '<path d="M1.5 2 7 6 1.5 10z"/><circle cx="10.5" cy="10.5" r="4.5"/><path d="M10.5 8v2.5l1.8 1.2"/>',
  back: '<path d="M3.5 3v10"/><path d="M12.5 3.5 6 8l6.5 4.5z"/>',
  pause: '<path d="M5.5 3.5v9M10.5 3.5v9"/>',
  resume: '<path d="M5 3.5 12 8l-7 4.5z"/>',
};
// An icon whose name shows on hover, keyboard focus and touch screens.
function face(button, icon, name) {
  if (button.dataset.face === icon) return;
  button.dataset.face = icon;
  button.innerHTML = `<svg viewBox="0 0 16 16" aria-hidden="true">${RUN_ICONS[icon]}</svg><span class="tool-label">${name}</span>`;
}
// Two buttons for every way of running (classroom 2026-11-03): full run /
// back to start, and step-by-step run / pause / continue. Continue resumes
// the way the program was started.
function updateControls() {
  const gate = blocked(),
    why = executionBlock();
  for (let name of ["step", "source", "over", "out", "run", "demo", "next-bp"])
    $(name).disabled =
      busy ||
      dirty ||
      !!gate ||
      running ||
      !state ||
      !["paused", "waiting"].includes(state.status);
  $("back").disabled = busy || dirty || !!gate || running || !state?.step;
  // Without a caller there is nothing to return to: step out would just run
  // on to the end (classroom 2026-11-03).
  const outside = !state?.calls?.length,
    noStops = !activeBreakpoints().some((b) => !b.log);
  if (outside) $("out").disabled = true;
  if (noStops) $("next-bp").disabled = true;
  $("prev-bp").disabled = $("back").disabled || noStops;
  const back = started(),
    pausing = running && !stopRequested,
    resume = !running && !!state?.step && !!runMode && ["paused", "waiting"].includes(state?.status);
  if (back) $("run").disabled = (busy && !running) || !!gate || !target;
  if (pausing) $("demo").disabled = false;
  // Icons like the step tools, named on hover (classroom 2026-11-03).
  face($("run"), back ? "back" : "full", back ? t("toolbar.backToStart") : t("toolbar.run"));
  $("run").setAttribute("aria-label", back ? t("toolbar.backToStart") : t("toolbar.run.label"));
  face($("demo"), pausing ? "pause" : resume ? "resume" : "steps", pausing ? t("toolbar.pause") : resume ? t("toolbar.continue") : t("toolbar.steps"));
  $("demo").setAttribute("aria-label", pausing ? t("toolbar.pause.label") : resume ? t("toolbar.continue") : t("toolbar.steps"));
  // The speed only matters while stepping through, or paused in it.
  $("demo-speed-control").hidden = !(
    (running && demoing) ||
    (!running && runMode === "demo" && !!state?.step && ["paused", "waiting"].includes(state?.status))
  );
  for (const name of ["back", "step", "source", "over", "out", "run", "demo", "prev-bp", "next-bp"]) {
    const b = $(name);
    b.dataset.tipBase ??= b.dataset.tip || "";
    b.dataset.tip =
      name === "demo" && pausing
        ? t("toolbar.pause.tip")
        : name === "demo" && resume && !b.disabled
          ? runMode === "demo" ? t("toolbar.continue.steps") : t("toolbar.continue.run")
          : name === "run" && back && !b.disabled
            ? t("toolbar.backToStart.tip")
            : b.disabled && !why && name === "out" && outside
              ? t("toolbar.out.outside", { tip: b.dataset.tipBase })
              : b.disabled && !why && (name === "prev-bp" || name === "next-bp") && noStops
                ? t("toolbar.bp.none", { tip: b.dataset.tipBase })
                : b.disabled && why
              ? `${b.dataset.tipBase}${t("common.inParens", { text: why })}`
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
  $("status").title = info.text + (info.at ? `
${t("status.goToLine")}` : "");
}
function nextScope() {
  return assemblyScope(
    {
      files,
      assembly: workspace?.assembly() || { mode: "auto", files: [] },
      entry: workspace?.entry() || "",
    },
    Object.hasOwn(files,activeFile) ? activeFile : lastSourceFile || target?.entry || workspace?.entry(),
  );
}
const MODE_NAMES = () => ({ auto: t("assembly.mode.auto"), single: t("assembly.mode.single"), manual: t("assembly.mode.manualShort") });
const describeScope = (s) =>
  s.error
    ? t("scope.noSource")
    : s.files.length > 1
      ? t("scope.describe.many", { mode: MODE_NAMES()[s.mode], count: s.files.length, entry: s.entry })
      : `${MODE_NAMES()[s.mode]} ${s.entry}`;
const sameFiles = (a, b) =>
  [...a].sort().join("\n") === [...b].sort().join("\n");
// Why the loaded program must not run right now, if it must not: the student
// switched to a source outside it, or changed the way or the manual scope.
// Following execution into another file never causes this, because execution
// only reaches files inside the target.
// The loaded program in words: "hello.s", or "lab/main.s 和另外 1 个文件".
const runnable = (program) =>
  program.files.length > 1 ? t("scope.runnable.many", { entry: program.entry, count: program.files.length - 1 }) : program.entry;
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
          ? t("scope.outsideManual", { file: activeFile, program: runnable(target) })
          : t("scope.otherFile", { file: activeFile, program: runnable(target), file: activeFile, assemble: assembleLabel(), back }),
    };
  const scope = nextScope();
  if (
    scope.mode !== target.mode ||
    (scope.mode === "manual" &&
      (scope.entry !== target.entry || !sameFiles(scope.files, target.files)))
  )
    return {
      kind: "changed",
      text: t("scope.modeChanged", { change: scope.mode !== target.mode ? t("scope.modeChangedTo", { mode: { auto: t("assembly.mode.auto"), single: t("assembly.mode.single"), manual: t("assembly.mode.manualLong") }[scope.mode] }) : t("scope.manualChanged"), program: runnable(target) }),
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
    ? t("scope.assembleEntry", { entry: scope.entry })
    : t("scope.assembleFile", { file: activeFile });
}
function renderScope() {
  const scope = nextScope(),
    reason = scopeReason();
  $("target").textContent = !target
    ? t("editor.target.none")
    : target.files.length > 1
      ? t("editor.target.many", { entry: target.entry, count: target.files.length - 1 })
      : t("editor.target.one", { entry: target.entry });
  $("target").title = target
    ? `${t("editor.target.files", { mode: MODE_NAMES()[target.mode] })}
` +
      target.files.join("\n") +
      `
${t("editor.target.willChange")}`
    : t("editor.target.notYet");
  $("target").classList.toggle("stale", !!reason);
  $("assemble").title =
    t("toolbar.assemble.tipScope", { scope: scope.error || describeScope(scope) });
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
      ? [["assemble", t("scope.assembleAgain")]]
      : target.mode === "manual"
        ? [
            ["back", t("scope.backTo", { back: reason.back })],
            ["join", t("scope.addFile", { file: activeFile })],
          ]
        : [
            ["assemble", assembleLabel()],
            ["back", t("scope.backTo", { back: reason.back })],
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
    document.querySelectorAll(".menu-button").forEach((b) => b.setAttribute("aria-expanded", "false"));
    menu.hidden = !open;
    button.setAttribute("aria-expanded", String(open));
    if (open) menu.querySelector("button:not(:disabled)")?.focus();
  });
  // Like a desktop menubar: with one menu open, pointing at another opens it.
  button.addEventListener("mouseenter", () => {
    if (menu.hidden && document.querySelector(".menubar .menu:not([hidden])")) button.click();
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
    } else if ((e.key === "ArrowLeft" || e.key === "ArrowRight") && MENUS.some(([b]) => b === buttonId)) {
      const at = MENUS.findIndex(([b]) => b === buttonId),
        [next] = MENUS[(at + (e.key === "ArrowRight" ? 1 : MENUS.length - 1)) % MENUS.length];
      close();
      $(next).click();
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
setupMenu("engine", "engine-menu");
$("engine").addEventListener("click", () => {
  $("engine-delay").textContent = t("engine.state", { delay: $("delay").checked ? t("common.on") : t("common.off"), program: target ? describeScope(target) : t("status.notAssembled") });
});
const MENUS = [
  ["project-menu-button", "project-menu"],
  ["learn-menu-button", "learn-menu"],
  ["view-menu-button", "view-menu"],
];
for (const [button, menu] of MENUS) setupMenu(button, menu);
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
  notify(t("layout.reset"), { transient: true });
};
// The main editor's relation lines are configured where those relations are
// studied: in focus mode (classroom 2026-10-24). The settings move there
// whole, so every option stays available.
// Moved into focus mode, the line settings there read as the main view's.
const labelOverlaySettings = () =>
  (document.querySelector(".overlay-settings summary").textContent = t("focus.mainLines"));
labelOverlaySettings();
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
// Runtime writes become ordinary project files. Apply only changed runtime
// bytes, so state polls do not overwrite edits made in the text editor.
function syncRuntimeFiles(next) {
  const changed = next.generatedFiles || {};
  let updated = false;
  for (const [name, file] of Object.entries(changed)) {
    if (runtimeFiles[name] === file.hash || file.base64 == null) continue;
    try { if (pathName(name) !== name) continue; } catch { continue; }
    if (Object.hasOwn(files,name)) continue;
    const text = new TextDecoder().decode(Uint8Array.from(atob(file.base64),c=>c.charCodeAt(0)));
    data[name] = text;
    updated = true;
    if (activeFile === name && editor.state.doc.toString() !== text) {
      loadEditor = true;
      editor.dispatch({annotations: Transaction.addToHistory.of(false), changes:{from:0,to:editor.state.doc.length,insert:text},selection:{anchor:Math.min(editor.state.selection.main.head,text.length)}});
      loadEditor = false;
    }
  }
  runtimeFiles = Object.fromEntries(Object.entries(changed).map(([n,f])=>[n,f.hash]));
  if (updated) workspace?.changed();
}
function renderFiles() {
  workspace?.render();
}
function renderTabs() {
  const tabs = workspace?.tabs() || Object.keys(files);
  $("editor").classList.toggle("no-file", !activeFile);
  $("tabs").innerHTML = tabs.map(f =>
    `<span class="file-tab ${f === activeFile ? 'active' : ''}"><button data-tab="${esc(f)}" title="${esc(f)}">${esc(f)}</button><button class="close-tab" data-close-tab="${esc(f)}" aria-label="${t("tabs.close", { file: esc(f) })}" title="${t("tabs.close.tip")}">×</button></span>`
  ).join('') || `<span class="empty-tab">${t("tabs.empty")}</span>`;
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
// Whether a 32-bit binary value fits on one line in the register column,
// measured with the current code font and remembered for that width.
function binDigitsFit() {
  const box = $("registers"),
    key = box.clientWidth + codeFont;
  if (binDigitsFit.key === key) return binDigitsFit.fits;
  const probe = document.createElement("div");
  probe.className = "reg";
  probe.style.cssText = "position:absolute;visibility:hidden;white-space:nowrap";
  probe.innerHTML = `<span class="name">$zero</span><span class="value">${esc(fmt(-1, 4, "value").full)}</span>`;
  box.appendChild(probe);
  const need = probe.getBoundingClientRect().width,
    room = box.clientWidth - parseFloat(getComputedStyle(box).paddingLeft) - parseFloat(getComputedStyle(box).paddingRight);
  probe.remove();
  binDigitsFit.key = key;
  return (binDigitsFit.fits = need <= room);
}
// Dragging the column wider or narrower switches between digits and dots.
new ResizeObserver(() => {
  if (radix !== "bin" || !state) return;
  const before = binDigitsFit.fits;
  binDigitsFit.key = null;
  if (binDigitsFit() !== before) renderRegisters();
}).observe($("registers"));
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
  $("registers").classList.toggle("bin", bin);
  // A narrow column cannot hold 32 digits on a line: bits become dots,
  // filled for 1 and hollow for 0, a byte at a time, wrapping onto a second
  // line (classroom 2026-11-03).
  const dots = bin && !binDigitsFit();
  $("registers").classList.toggle("dots", dots);
  const text = (value, name) =>
    dots
      ? bitDots(value, 4, fmt(value, 4, regKind(name)).full)
      : bin
        ? esc(fmt(value, 4, regKind(name)).full)
        : esc(fmt(value, 4, regKind(name)).text);
  // A register the step just wrote shows what it replaced: the old value
  // struck through above the new one (classroom 2026-11-03). Only for a
  // completed step; a preview has not written anything yet. Binary values
  // are too long to show twice.
  const replaced = new Map(
    (bin ? [] : state.last?.accesses || [])
      .filter((a) => a.kind === "register" && a.write && a.before != null)
      .map((a) => [a.name, a.before]),
  );
  const shown = (r) =>
    replaced.has(r.name)
      ? `<s class="old" aria-label="${t("registers.oldValue")}">${text(replaced.get(r.name), r.name)}</s><span class="new">${text(r.value, r.name)}</span>`
      : text(r.value, r.name);
  // What the prefixes mean, right where the values are (round-4 trial: the
  // footer legend went unnoticed).
  $("reg-legend").textContent = {
    auto: t("registers.legend.auto"),
    hex: t("registers.legend.hex"),
    dec: t("registers.legend.dec"),
    bin: t("registers.legend.bin"),
    ascii: t("registers.legend.ascii"),
  }[radix];
  // A negative value in BIN: the top bit says so (two's complement).
  const signNote = (r) =>
    bin && r.value < 0 && regKind(r.name) === "value"
      ? `
${t("registers.signNote", { value: r.value | 0 })}`
      : "";
  $("registers").innerHTML = state.registers
    .filter((r) =>
      filter === "all" || filter === "pinned"
        ? filter === "all" || pinned.has(r.name)
        : related.has(r.name) || pinned.has(r.name),
    )
    .map(
      (r) =>
        `<div tabindex="0" class="reg ${all.some((a) => a.name === r.name && !a.write) ? "read" : ""} ${all.some((a) => a.name === r.name && a.write) ? "write" : ""} ${pinned.has(r.name) ? "pinned" : ""} ${focus === r.name ? "focus" : ""}" data-register="${r.name}" title="${t("registers.tip", { name: r.name, role: esc(role(r.name)), full: esc(fmt(r.value, 4, regKind(r.name)).full), note: fmt(r.value, 4, regKind(r.name)).note ? " · " + esc(fmt(r.value, 4, regKind(r.name)).note) : "", sign: esc(signNote(r)), legend: esc($("reg-legend").textContent) })}"><span class="name">${r.name}</span><span class="value${replaced.has(r.name) ? " replaced" : ""}">${shown(r)}</span></div>`,
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
// The memory panel (classroom 2026-11-04): one list of the same bytes shown
// as bytes, words or text, with a row for each data label, a thin bar of the
// whole address space beside it, and a map that the bar opens into.
// i18n-keys: memory.view.*
// i18n-keys: memory.segment.*
let memView = "words",
  memMapOpen = false,
  memAnchor = null;
try {
  memView = localStorage.getItem("memView") || "words";
} catch {}
const MEM_WINDOW = 256,
  MEM_STEP = 64;
const memSymbols = () => dataSymbols(program.symbols, files);
function renderMemory() {
  if (!state) {
    // Nothing assembled yet: say how to get memory here, not a blank panel.
    $("memory").innerHTML = `<p class="mem-empty">${t("memory.empty")}</p>`;
    return renderMemoryBar();
  }
  if (document.activeElement !== $("address")) $("address").value = hex(state.memoryBase);
  const all = accesses().filter((a) => a.kind === "memory");
  const touched = (address, width, write) =>
    all.some((a) => !a.write === !write && address < a.address + a.width && a.address < address + width);
  const symbols = memSymbols();
  const rows = memoryRows(state.memory, symbols, memView);
  const cell = (c) => {
    const word = c.width === 4,
      unknown = c.bytes.some((b) => b == null),
      title = unknown
        ? hex(c.address)
        : `${hex(c.address)} · ${esc(formatValue(word ? wordValue(c.bytes) : c.bytes[0], { radix: radix === "auto" ? "hex" : radix, width: c.width, kind: "bits" }).text)}`;
    const shown = unknown ? "??".repeat(c.width) : word ? wordCell(c.bytes) : memView === "text" ? (c.bytes[0] === 32 ? "\u2423" : escapeByte(c.bytes[0])) : memoryCell(c.bytes[0]);
    const focused = focus?.startsWith("mem:") && Number(focus.slice(4)) >= c.address && Number(focus.slice(4)) < c.address + c.width;
    return `<span tabindex="0" class="byte${word ? " word" : ""}${touched(c.address, c.width, false) ? " read" : ""}${touched(c.address, c.width, true) ? " write" : ""}${focused ? " focus" : ""}${!word && memView === "text" && !unknown && !(c.bytes[0] > 32 && c.bytes[0] < 127) ? " escape" : ""}" data-byte="${c.address}" data-width="${c.width}" title="${title}">${esc(shown)}</span>`;
  };
  $("memory").innerHTML = rows
    .map((r) =>
      r.label
        ? `<div class="mem-label"><button type="button" data-mem-symbol="${esc(r.label.name)}" title="${esc(t("memory.symbolTip", { view: t(`memory.view.${r.label.view}`) }))}">${esc(r.label.name)}</button><small>${esc(r.label.directive || "")} · ${t("memory.size", { n: r.label.size })}</small></div>`
        : `<div class="mem-row"><span class="mem-address">${hex(r.address).slice(2)}</span>${r.cells.map(cell).join("")}${memView === "bytes" ? `<span class="ascii">${r.cells.map((c) => (c.bytes[0] >= 32 && c.bytes[0] < 127 ? esc(String.fromCharCode(c.bytes[0])) : ".")).join("")}</span>` : ""}</div>`,
    )
    .join("");
  $("memory").dataset.radix = radix;
  $("memory").dataset.view = memView;
  // Text has no radix: the label keeps its place but is hidden, so
  // switching views never moves the header (classroom 2026-11-05).
  $("mem-radix").classList.toggle("idle", memView === "text");
  $("mem-radix").textContent =
      {
          auto: t("memory.cells.hex"),
          hex: t("memory.cells.hex"),
          dec: t("memory.cells.dec"),
          bin: t("memory.cells.bin"),
          ascii: t("memory.cells.ascii"),
        }[radix];
  document.querySelectorAll("[data-mem-view]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.memView === memView)));
  $("memory")
    .querySelectorAll("[data-byte]")
    .forEach((e) => {
      e.onclick = () => inspectByte(Number(e.dataset.byte));
      e.onkeydown = (k) => {
        if (k.key === "Enter") e.click();
      };
    });
  $("memory")
    .querySelectorAll("[data-mem-symbol]")
    .forEach((b) => {
      const s = symbols.find((x) => x.name === b.dataset.memSymbol);
      b.onclick = () => showMemory(s.address, s.view === "bytes" ? memView : s.view);
    });
  // Keep the row that was under the reader where it was after a shift.
  if (memAnchor) {
    const row = $("memory").querySelector(`[data-byte="${memAnchor.address}"]`);
    if (row) $("memory").scrollTop += row.getBoundingClientRect().top - memAnchor.top;
    memAnchor = null;
  }
  renderMemoryBar();
  if (memMapOpen) renderMemoryMap();
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
function wordCell(bytes) {
  const v = wordValue(bytes);
  if (radix === "dec") return String(v);
  if (radix === "bin") return (v >>> 0).toString(2).padStart(32, "0").match(/.{8}/g).join(" ");
  if (radix === "ascii") return bytes.map((b) => escapeByte(b)).join("");
  return (v >>> 0).toString(16).padStart(8, "0");
}
function inspectByte(address) {
  following = false;
  focus = "mem:" + address;
  let value = state.memory.find((b) => b.address === address)?.value,
    last = state.lastWriters["mem:" + address];
  inspecting = null;
  showContext(
    `<h3>${t("memory.byte.title", { address: hex(address) })}</h3><p>${t("memory.byte.what")}</p>${value == null ? `<p>${t("memory.byte.inaccessible")}</p>` : valueHTML(value)}<button id="watch-memory">${t("memory.byte.watch")}</button><button id="memory-last-write" ${last ? "" : "disabled"}>${t("memory.byte.lastWrite", { step: last ? "#" + last : "" })}</button>`,
  );
  $("memory-last-write").onclick = () => command("seek", { step: last });
  $("watch-memory").onclick = () => {
    watches.push({ address, access: "write" });
    renderStops();
  };
  renderMemory();
  overlay.schedule();
}
// Show memory from an address on: rows start on a word boundary.
async function memoryAt(address) {
  await command("memory", { address: address & ~3, length: MEM_WINDOW });
  $("memory").scrollTop = 0;
  overlay.schedule();
}
// Jump there in a given view, closing the map (it opened only to choose).
function showMemory(address, view = memView) {
  setMemView(view, false);
  setMemMap(false);
  return memoryAt(address);
}
function setMemView(view, render = true) {
  memView = view;
  try {
    localStorage.setItem("memView", view);
  } catch {}
  if (render) {
    renderMemory();
    overlay.schedule();
  }
}
// Move the window by a number of bytes, keeping the rows on screen in place.
async function shiftMemory(delta) {
  if (!state) return;
  const box = $("memory").getBoundingClientRect(),
    first = [...$("memory").querySelectorAll(".mem-row [data-byte]")].find((e) => e.getBoundingClientRect().bottom > box.top);
  memAnchor = first ? { address: Number(first.dataset.byte), top: first.getBoundingClientRect().top } : null;
  await command("memory", { address: (state.memoryBase + delta) & ~3, length: MEM_WINDOW });
  overlay.schedule();
}
function memoryLayout() {
  const symbols = memSymbols(),
    last = program.instructions[program.instructions.length - 1];
  return memoryBar({
    layout: state?.layout,
    sp: regValue("$sp"),
    dataEnd: symbols.length ? symbols[symbols.length - 1].end : 0,
    textEnd: last ? last.address + 4 : 0,
  });
}
function renderMemoryBar() {
  const segments = state?.layout ? memoryLayout() : [];
  const ready = segments.length > 0;
  $("memory-bar").classList.toggle("empty", !ready);
  $("memory-bar").title = ready ? "" : t("memory.bar.notReady");
  $("mem-expand").disabled = !ready;
  if (!ready) {
    // The same five segments, greyed out until there is a program.
    $("mem-track").innerHTML = [0.22, 0.3, 0.14, 0.1, 0.24].map((share) => `<span class="seg" style="flex:${share}"></span>`).join("");
    return;
  }
  const pos = (a) => barPosition(segments, a),
    view = pos(state.memoryBase),
    sp = pos(regValue("$sp")),
    pc = pos(state.pc);
  $("mem-track").innerHTML =
    segments
      .map(
        (s) =>
          `<button type="button" class="seg seg-${s.id}" style="flex:${s.share}" ${s.id === "free" ? "disabled" : `data-seg="${s.id}"`} title="${esc(t(`memory.segment.${s.id}`))}${s.from != null ? ` · ${hex(s.from)}` : ""}" aria-label="${esc(t(`memory.segment.${s.id}`))}"></button>`,
      )
      .join("") +
    (sp ? `<span class="tick tick-sp" style="top:${sp.y * 100}%" title="$sp ${hex(regValue("$sp"))}"></span>` : "") +
    (pc ? `<span class="tick tick-pc" style="top:${pc.y * 100}%" title="PC ${hex(state.pc)}"></span>` : "") +
    (view ? `<span class="view-mark" style="top:${view.y * 100}%" title="${esc(t("memory.bar.viewing", { address: hex(state.memoryBase) }))}">▶</span>` : "");
  $("mem-track")
    .querySelectorAll("[data-seg]")
    .forEach((b) => (b.onclick = () => jumpToSegment(b.dataset.seg)));
}
function jumpToSegment(id) {
  const l = state.layout;
  if (id === "stack") return showMemory(regValue("$sp"), "words");
  if (id === "heap") return showMemory(state.heapBlocks[0]?.address ?? l.heap, "words");
  if (id === "data") return showMemory(l.data);
  if (id === "text") return showMemory(state.pc, "words");
}
function setMemMap(open) {
  memMapOpen = open && !!state?.layout;
  $("panel-memory").classList.toggle("map-open", memMapOpen);
  $("memory-map").hidden = !memMapOpen;
  $("mem-expand").setAttribute("aria-expanded", String(memMapOpen));
  const label = memMapOpen ? t("memory.map.close") : t("memory.map.open");
  $("mem-expand").title = label;
  $("mem-expand").setAttribute("aria-label", label);
  if (memMapOpen) renderMemoryMap();
  overlay.schedule();
}
// Registers a function saves on entry: "sw $r, off($sp)" in its first
// instructions, at the $sp it has after making room for them.
function savedRegisters(entry, sp) {
  const start = program.instructions.findIndex((i) => i.address === entry);
  const saved = [];
  let delta = 0;
  for (const ins of program.instructions.slice(Math.max(0, start), start < 0 ? 0 : start + 12)) {
    // Basic code writes immediates in hex: 0xfffffff0 is -16.
    const grow = /^addiu?\s+\$(?:29|sp),\s*\$(?:29|sp),\s*(-?(?:0x[\da-f]+|\d+))/i.exec(ins.basic);
    if (grow) delta += (Number(grow[1]) << 16) >> 16;
    const store = /^sw\s+(\$\w+),\s*(-?(?:0x[\da-f]+|\d+))\(\$(?:29|sp)\)/i.exec(ins.basic);
    if (store) saved.push({ name: regName(store[1]), address: (sp + delta + ((Number(store[2]) << 16) >> 16)) | 0 });
    if (/^(jr|j|jal|b\w*)\b/.test(ins.basic)) break;
  }
  return saved;
}
function regName(r) {
  const n = /^\$(\d+)$/.exec(r);
  return n ? state.registers[Number(n[1])]?.name ?? r : r;
}
function renderMemoryMap() {
  if (!state?.layout) return;
  const sp = regValue("$sp"),
    fp = regValue("$fp"),
    top = (state.layout.stack + 4) | 0,
    symbolAt = (a) => program.symbols.find((s) => s.address === a)?.name;
  // Frames from the oldest call to the newest; each runs from the $sp at its
  // call down to the next one's (or the $sp now, for the innermost).
  const frames = state.calls.map((c, i) => {
    const below = i + 1 < state.calls.length ? state.calls[i + 1].sp : sp;
    return {
      name: symbolAt(c.instruction.target) || hex(c.instruction.target ?? 0),
      high: c.sp,
      low: below,
      step: c.step,
      saved: savedRegisters(c.instruction.target, c.sp),
    };
  });
  const item = (attrs, body) => `<button type="button" class="map-item" ${attrs}>${body}</button>`;
  // Low addresses first, as in the list: $sp, then the newest frame up to
  // the stack's start.
  const stack = [
    item(`data-map-address="${sp}" data-map-view="words"`, `<b>$sp</b><small>${hex(sp)}</small><span class="map-arrow">\u2190 $sp</span>`),
    ...frames
      .slice()
      .reverse()
      .map((f) =>
        item(
          `data-map-address="${f.low}" data-map-view="words"`,
          `<b>${esc(f.name)}</b><small>${t("memory.map.frame", { step: f.step, size: (f.high - f.low) | 0 })}</small>${f.saved.length ? `<span class="map-saved">${f.saved.map((s) => `<span>${esc(s.name)} @ ${hex(s.address).slice(2)}</span>`).join("")}</span>` : ""}${fp >>> 0 >= f.low >>> 0 && fp >>> 0 < f.high >>> 0 ? `<span class="map-arrow">\u2190 $fp</span>` : ""}`,
        ),
      ),
    item(`data-map-address="${frames.length ? frames[0].high : top - 4}" data-map-view="words"`, `<b>${t("memory.map.startFrame")}</b><small>${hex(top)}</small>`),
  ];
  const heap = state.heapBlocks.length
    ? state.heapBlocks.map((h) =>
        item(`data-map-address="${h.address}" data-map-view="words"`, `<b>${t("memory.map.heapBlock", { step: h.step })}</b><small>${hex(h.address)} · ${t("memory.size", { n: h.size })}</small>`),
      )
    : [`<p class="muted">${t("memory.map.noHeap")}</p>`];
  const data = memSymbols().map((s) =>
    item(`data-map-address="${s.address}" data-map-view="${s.view}"`, `<b>${esc(s.name)}</b><small>${hex(s.address)} · ${esc(s.directive || "")} · ${t("memory.size", { n: s.size })}</small>`),
  );
  const place = program.instructions.find((i) => i.address === state.pc);
  const text = [
    state.status === "ended" || !place
      ? `<p class="muted">${t("memory.map.noPc")}</p>`
      : item(`data-map-pc`, `<b>PC</b><small>${hex(state.pc)} · ${esc(place.file)}:${place.line}</small><span class="map-saved">${esc(place.basic)}</span>`),
  ];
  const section = (id, body, address) =>
    `<section class="map-seg map-${id}"><h4>${t(`memory.segment.${id}`)}${address == null ? "" : ` <small>${hex(address)}</small>`}</h4>${body.join("")}</section>`;
  $("memory-map").innerHTML =
    section("text", text, state.layout.text) +
    section("data", data.length ? data : [`<p class="muted">${t("memory.map.noData")}</p>`], state.layout.data) +
    section("heap", heap, state.layout.heap) +
    `<div class="map-free">${t("memory.segment.free")}</div>` +
    section("stack", stack, sp);
  $("memory-map")
    .querySelectorAll("[data-map-address]")
    .forEach((b) => {
      const view = b.dataset.mapView;
      b.onclick = () => showMemory(Number(b.dataset.mapAddress), view === "bytes" ? memView : view);
    });
  const pcItem = $("memory-map").querySelector("[data-map-pc]");
  if (pcItem)
    pcItem.onclick = () => {
      setMemMap(false);
      gotoSource(place.file, place.line);
    };
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
    `<p class="muted">${t("cfg.legend")}</p>` +
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
        return `<article class="block ${b.instructions.some((i) => i.address === state?.pc) ? "current" : ""}" id="block-${b.id}"><div class="block-title"><button data-jump="${b.start}">${hex(b.start)} · ${esc(program.symbols.find((s) => s.address === b.start)?.name || "block")}</button><span>${t("cfg.entered", { count, backJumps: loop ? ` ${t("cfg.backJumps", { backJumps: loop.backJumps })}` : "" })}</span></div>${b.instructions.map((i) => `<code>${esc(i.basic)}</code>`).join("")}<div class="edges">${b.edges.map((e) => `<button data-block-target="${e.target ?? ""}">${e.label} → ${e.target == null ? t("common.unknown") : hex(e.target)}</button>`).join("")}</div></article>`;
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
    `<button class="trace-row ${e.step === state.step ? "selected" : ""}" data-seek="${e.step}"><span>#${e.step}</span><span>${esc(e.instruction?.basic)}</span><small>${esc(e.instruction?.file)}:${e.instruction?.line}${e.output ? ` ${t("trace.output")}` : ""}</small></button>`;
  $("trace").innerHTML =
    `<div><input id="seek-number" type="number" min="0" max="${state?.historyLength || 0}" value="${state?.step || 0}" aria-label="${t("trace.historyStep")}"><button id="seek-go">${t("trace.goToStep")}</button><span class="muted">${t("trace.window")}</span></div>` +
    (state?.loops || [])
      .filter((loop) => loop.entries > 0)
      .map(
        (loop) =>
          `<details class="loop-history"><summary>${t("trace.loop", { header: hex(loop.header), entries: loop.entries, backJumps: loop.backJumps })}</summary>${loop.iterations
            .slice(-200)
            .map(
              (step, index) =>
                `<button class="trace-row" data-seek="${step - 1}">${t("trace.iteration", { n: Math.max(0, loop.iterations.length - 200) + index + 1, step })}</button>`,
            )
            .join("")}</details>`,
      )
      .join("") +
    groups
      .map((g) =>
        g.events.length > 1
          ? `<details><summary>${t("trace.lineGroup", { key: esc(g.key), count: g.events.length })}</summary>${g.events.map(row).join("")}</details>`
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
    ? t("console.input.waiting")
    : t("console.input.placeholder");
  renderFiles();
  renderTabs();
  renderSymbols();
  renderRegisters();
  renderMemory();
  renderTrace();
  renderStops();
  renderLogs();
  renderOutput();
  $("pc").textContent = "PC " + hex(state.pc);
  requestAnimationFrame(updateReturn);
  $("history-info").textContent = t("history.position", { step: state.step, total: state.historyLength });
  $("calls").innerHTML =
    `${state.calls
      .map(
        (c) =>
          `<button class="trace-row" data-call="${c.step}">${t("calls.row", { step: c.step, call: esc(c.instruction.basic), address: hex(c.return) })}</button>`,
      )
      .join("")}<p class="muted">${t("calls.legend")}</p>`;
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
          `<button class="command-item" data-diagnostic="${i}">${esc(d.file)}:${d.line} · ${esc(marsText(d.message))}${hints[i] ? `<small class="scope-hint">${esc(hints[i])}</small>` : ""}</button>`,
      )
      .join("") + (state.error ? `<pre>${esc(marsText(state.error))}</pre>` : "");
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
  updateControls();
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
    t("breakpoint.edit.title", { file: ins.file, line: ins.line }),
    `<form id="bp-form" class="bp-form">
      <label><input type="checkbox" id="bp-enabled" ${b.enabled ? "checked" : ""}> ${t("breakpoint.enabled")}</label>
      <label>${t("breakpoint.condition")}<input id="bp-condition" value="${esc(b.condition)}" placeholder="${t("breakpoint.condition.placeholder")}"></label>
      <label>${t("breakpoint.hit")}<input id="bp-hit" type="number" min="0" value="${b.hit || ""}" placeholder="${t("breakpoint.hit.placeholder")}"></label>
      <label>${t("breakpoint.log")}<input id="bp-log" value="${esc(b.log)}" placeholder="${t("breakpoint.log.placeholder")}"></label>
      <p class="muted">${t("breakpoint.edit.note")}</p>
      <p><button class="primary">${t("common.save")}</button> <button type="button" id="bp-remove">${t("breakpoint.delete")}</button></p>
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
  if (!Object.hasOwn(files, activeFile)) return;
  const kept = breakpoints.find(
    (b) => b.file === activeFile && b.line === line && b.address == null,
  );
  if (kept) {
    breakpoints = breakpoints.filter((b) => b !== kept);
    breakpointChanged();
    return;
  }
  if (target && !target.files.includes(activeFile)) {
    notify(t("breakpoint.notAssembled", { file: activeFile }), {
      transient: true,
    });
    return;
  }
  const at = breakableAddress(line);
  if (!at) {
    notify(
      dirty
        ? t("breakpoint.dirty")
        : t("breakpoint.noInstruction"),
      { transient: true },
    );
    return;
  }
  if (at.label)
    notify(t("breakpoint.onLabel", { line: at.line }), {
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
    : `<p class="muted">${t("logs.empty")}</p>`;
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
      `<span class="echo" title="${t("console.echo")}">${esc(e.text)}</span>
`;
    from = e.at;
  }
  $("output").innerHTML = html + esc(state.output.slice(from));
  $("output").scrollTop = $("output").scrollHeight;
}
function renderStops() {
  $("breakpoints").innerHTML = breakpoints
    .map((b, i) => {
      const details = [
        b.condition && t("breakpoint.row.condition", { condition: b.condition }),
        b.hit && t("breakpoint.row.hit", { hit: b.hit }),
        b.log && t("breakpoint.row.log", { log: b.log }),
      ].filter(Boolean);
      return `<div class="bp-row ${b.enabled ? "" : "off"}">
        <input type="checkbox" data-bp-enable="${i}" ${b.enabled ? "checked" : ""} aria-label="${t("breakpoint.row.enable", { file: esc(b.file), line: b.line })}">
        <button class="bp ${b.address == null ? "stale" : ""}" data-bp="${i}">${breakpointGlyph(b)} ${esc(b.file)}:${b.line}<br><small>${esc(b.address == null ? t("breakpoint.row.inactive") : details.join(" · ") || hex(b.address))}</small></button>
        <button data-bp-edit="${i}" aria-label="${t("breakpoint.row.edit")}" title="${t("breakpoint.row.edit")}">✎</button><button data-bp-remove="${i}" aria-label="${t("breakpoint.delete")}" title="${t("breakpoint.delete")}">×</button>
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
  // How the program was last started ("run" or "demo"); Continue resumes it.
  runMode = "",
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
  if ((mode === "run" || mode === "demo") && !extra.keepMode) runMode = mode;
  stopRequested = false;
  let finish;
  runDone = new Promise((resolve) => (finish = resolve));
  try {
    await runLoop(mode, extra);
  } finally {
    running = false;
    stopRequested = false;
    demoing = false;
    followHold = 0;
    updateControls();
    finish();
  }
  arrive(mode !== "source");
  followInspector();
  lens.settle();
}
// Step-by-step speed in steps (machine instructions) per second.
const DEMO_RATES = [0.5, 1, 2, 4, 8, 16];
const demoRate = () => DEMO_RATES[Number($("demo-speed").value) - 1];
function updateDemoSpeed() {
  const text = t("toolbar.speed.rate", { rate: demoRate() });
  $("demo-speed-label").textContent = text;
  $("demo-speed").setAttribute("aria-valuetext", t("toolbar.speed.value", { rate: demoRate() }));
  $("demo-speed").title = t("toolbar.speed.tip", { rate: text });
}
$("demo-speed").addEventListener("input", updateDemoSpeed);
updateDemoSpeed();

async function runLoop(mode, extra) {
  updateControls();
  let first = true;
  // F5 runs at full speed like VS Code; "演示" steps one instruction at a time
  // and follows the PC so a class can watch (decided after the 2026-10-22 trial).
  const demonstrate = mode === "demo";
  if (demonstrate) mode = "run";
  pendingResume = null;
  while (!stopRequested) {
    const began = performance.now();
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
    // Step-by-step pace: one instruction at a time so the PC can be followed;
    // the request's own time counts towards the interval. Step-by-step
    // narration lives in focus mode (DESIGN §3.8).
    if (demonstrate && s?.last) {
      followPC();
      const wait = 1000 / demoRate() - (performance.now() - began);
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, wait)));
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
    `<form id="ask-form"><input id="ask-value" style="width:100%" value="${esc(value)}" autofocus><p><button class="primary">${t("common.ok")}</button></p></form>`,
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
  setView("source"); switchFile(name); editor.focus();
}
function commandList() {
  const commands = [
    [t("commands.assemble"), assemble, "assemble"],
    [t("commands.newProject"), () => $("new-project").click()],
    [t("commands.import"), () => $("import").click()],
    [t("commands.saveLocal"), () => $("save-local").click()],
    [t("commands.export"), () => $("save").click()],
    [t("commands.quickOpen"), () => openPicker(""), "quickOpen"],
    [t("commands.outline"), () => openPicker("@"), "outline"],
    [t("focus.open"), () => openFocus(), "focus"],
    [t("toolbar.step"), () => command("step").then(followPC), "step"],
    [t("toolbar.source"), () => run("source"), "source"],
    [t("toolbar.over"), () => run("over"), "over"],
    [t("toolbar.out"), () => run("out"), "out"],
    [t("toolbar.back"), () => command("back").then(followPC), "back"],
    [t("toolbar.nextBp"), () => $("next-bp").click()],
    [t("toolbar.prevBp"), () => $("prev-bp").click()],
    [t("commands.run"), () => actions.run(), "run"],
    [t("commands.steps"), () => run("demo")],
    [t("commands.backToStart"), () => backToStart()],
    [t("commands.restart"), () => assemble(), "restart"],
    [t("toolbar.pause"), () => requestStop(), "pause"],
    [t("commands.stop"), () => actions.stop(), "stop"],
    [t("commands.toggleBreakpoint"), () => actions.breakpoint(), "breakpoint"],
    [
      t("commands.runToCursor"),
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
    [t("commands.machine"), () => setView("machine")],
    [t("commands.cfg"), () => setView("cfg")],
    [
      t("commands.allRegisters"),
      () => {
        $("reg-filter").value = "all";
        renderRegisters();
      },
    ],
    [t("commands.memoryAddress"), () => $("address").focus()],
    [
      t("commands.toggleSolid"),
      () => {
        $("solid").checked = !$("solid").checked;
        overlay.schedule();
      },
    ],
    [
      t("commands.toggleDashed"),
      () => {
        $("dashed").checked = !$("dashed").checked;
        overlay.schedule();
      },
    ],
    [t("commands.syscalls"), () => inspectToken("syscall")],
    [t("commands.findInstruction"), () => findInstruction()],
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
    t("find.title"),
    `<input id="find-input" aria-label="${t("find.label")}" autocomplete="off" placeholder="${t("find.placeholder")}" style="width:100%"><div id="find-list" role="listbox" aria-label="${t("find.results")}"></div><div id="find-detail" aria-live="polite"></div>`,
  );
  const input = $("find-input");
  input.value = query;
  let results = [],
    selected = 0;
  const kindOf = (x) => (x.kind === "service" ? "syscall" : x.pseudo ? t("find.kind.pseudo") : t("find.kind.instruction"));
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
        ? `<p class="muted">${t("find.none")}</p>`
        : `<p class="muted">${t("find.empty")}</p>`;
      return;
    }
    const used = uses(x);
    const rows = [
      [t("find.use"), esc(x.purpose)],
      [t("find.format"), `<code class="find-code">${esc(x.format)}</code>`],
      x.formula && [t("find.formula"), `<code>${esc(x.formula)}</code>`],
      x.example && x.example !== x.format && [t("common.example"), `<code class="find-code">${esc(x.example)}</code>`],
      x.note && [t("find.note"), esc(x.note)],
    ].filter(Boolean);
    $("find-detail").innerHTML = `<div class="inspect-head"><h3>${esc(x.label)}</h3><span>${kindOf(x)}</span></div><dl class="detail-steps">${rows.map(([t, d]) => `<dt>${t}</dt><dd>${d}</dd>`).join("")}</dl>${used.length ? `<p class="muted">${t("find.used")}</p>${used.map((u, i) => `<button class="command-item" data-use="${i}">${esc(u.file)}:${u.line} <small class="mono">${esc(u.text)}</small></button>`).join("")}` : `<p class="muted">${t("find.unused")}</p>`}`;
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
          `<details class="find-more" ${moreOpen ? "open" : ""}><summary>${t("find.related", { count: results.length - strong })}</summary>${results.slice(strong).map((x, k) => row(x, strong + k)).join("")}</details>`
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
  finish: async (completed) => {
    const saved = await get(TUTORIAL_BACKUP).catch(() => null);
    modal(
      completed ? t("tutorial.finished") : t("tutorial.exit"),
      `<p>${t("tutorial.exit.note", { praise: completed ? t("tutorial.wellDone") : "", back: saved ? t("tutorial.backTo", { name: esc(saved.name || t("project.defaultName")) }) : "" })}</p><div class="project-actions"><button id="tutorial-continue">${t("tutorial.keepGoing")}</button>${saved ? `<button id="tutorial-restore">${t("tutorial.restore")}</button>` : ""}<button class="primary" id="tutorial-keep">${t("tutorial.keepProject")}</button></div>`,
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
          await drop(TUTORIAL_BACKUP);
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
    t("tutorial.start.title"),
    `<p class="project-explanation">${t("tutorial.start.about")}</p><p class="muted">${t("tutorial.start.safe")}</p><div class="project-actions"><button id="tutorial-cancel">${t("common.cancel")}</button><button class="primary" id="tutorial-begin">${t("tutorial.start.begin")}</button></div>`,
  );
  $("tutorial-cancel").onclick = () => $("modal").close();
  $("tutorial-begin").onclick = async () => {
    try {
      await put(TUTORIAL_BACKUP, workspace.snapshot());
    } catch {
      $("modal").close();
      return notify(t("tutorial.start.noStorage"));
    }
    try {
      await workspace.apply({ name: t("menu.learn.tutorial"), files: {}, data: {}, folders: [] });
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
    prefix === ">" ? t("commands.palette") : t("picker.quickOpen"),
    `<input id="picker-input" aria-label="${t("picker.search")}" autocomplete="off" style="width:100%"><div id="picker-list" role="listbox"></div><p class="muted picker-help">${t("picker.hint")} > ${t("picker.hint.commands")}</p>`,
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
      files, data,
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
        .join("") || `<p class="muted">${t("picker.none")}</p>`;
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
    if (input.value.startsWith("?") || input.value.startsWith("\uff1f"))
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
$("demo").onclick = () =>
  running ? requestStop() : run(state?.step && runMode ? runMode : "demo");
$("back").onclick = () =>
  command("back").then(() => {
    followPC();
    arrive();
  });
$("run").onclick = () => (started() ? backToStart() : run("run"));
// Breakpoint to breakpoint: forward runs at full speed and leaves how the
// program was started alone; back looks through the recorded history.
$("next-bp").onclick = () => run("run", { keepMode: true });
$("prev-bp").onclick = async () => {
  await command("previousBreakpoint", { breakpoints: activeBreakpoints() });
  if (state?.stopReason === "No earlier breakpoint")
    notify(t("toolbar.prevBp.none"), { transient: true });
  followPC();
  arrive(true);
};
for (let mode of ["source", "over", "out"]) $(mode).onclick = () => run(mode);
$("commands").onclick = openCommands;
$("commands-key").textContent = IS_MAC ? "⇧⌘P" : "Ctrl+Shift+P";
const renderRadixOptions = () =>
  ($("radix").innerHTML = RADIXES.map(
    ([value, label]) =>
      `<option value="${value}" title="${esc(RADIX_HELP[value])}" ${value === radix ? "selected" : ""}>${label}</option>`,
  ).join(""));
renderRadixOptions();
// What the notations mean, plus a character table to look 104 → h up in.
$("radix-help").onclick = () => {
  const cell = (b) =>
    `<td><code>${b}</code></td><td><code>0x${b.toString(16).padStart(2, "0")}</code></td><td><b>${esc(escapeByte(b) === " " ? t("radix.table.space") : escapeByte(b))}</b></td>`;
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
    t("radix.help.heading"),
    `<div class="radix-help"><p class="radix-example">${t("radix.help.same", { forms: ["dec", "hex", "bin", "ascii"].map((m) => `<code>${esc(formatValue(104, { radix: m, width: 1, kind: "bits" }).text)}</code>`).join(" = ") })}</p>${RADIXES.map(([v, l]) => `<p><b>${l}</b> ${esc(RADIX_HELP[v].replace(/^[^：:]+[：:]\s*/, ""))}</p>`).join("")}
     <p class="muted">${t("radix.help.scope")}</p>
     <h4>${t("radix.help.table")}</h4>
     <p class="muted">${t("radix.help.tableNote")}</p>
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
    return notify(t("focus.needsAssembly"));
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
  $("zoom").title = t("menu.view.codeSize.largerNow", { size: fontSize });
  $("zoom-out").title = t("menu.view.codeSize.smallerNow", { size: fontSize });
  $("zoom").disabled = fontSize >= 22;
  $("zoom-out").disabled = fontSize <= 11;
  try {
    localStorage.setItem("code-size", String(fontSize));
  } catch {}
  editor.requestMeasure();
  overlay.schedule();
}
$("zoom").onclick = () => setFontSize(fontSize + 1);
// Code font (classroom 2026-11-03): five bundled fonts, or the operating
// system's own, which differs between macOS, Windows and Linux.
const osName = () => /Mac|iPhone|iPad/.test(navigator.platform)
  ? t("fonts.system.mac")
  : /Win/.test(navigator.platform)
    ? t("fonts.system.windows")
    : t("fonts.system.linux");
const codeFonts = () => [
  ["jetbrains", "JetBrains Mono", '"JetBrains Mono Web"'],
  ["fira", "Fira Code", '"Fira Code Web"'],
  ["cascadia", "Cascadia Code", '"Cascadia Code Web"'],
  ["source", "Source Code Pro", '"Source Code Pro Web"'],
  ["plex", "IBM Plex Mono", '"IBM Plex Mono Web"'],
  ["system", t("fonts.system"), ""],
];
let codeFont = "jetbrains";
function setCodeFont(id) {
  const fonts = codeFonts(),
    font = fonts.find(([key]) => key === id) || fonts[0];
  codeFont = font[0];
  document.documentElement.style.setProperty(
    "--mono",
    font[2] ? `${font[2]}, var(--mono-system)` : "var(--mono-system)",
  );
  $("font-list").querySelectorAll("[data-font]").forEach((b) =>
    b.setAttribute("aria-checked", String(b.dataset.font === codeFont)),
  );
  try {
    localStorage.setItem("code-font", codeFont);
  } catch {}
  // Glyph widths change: the editor and the connecting lines re-measure
  // once the font has loaded.
  document.fonts?.ready.then(() => {
    editor.requestMeasure();
    overlay.schedule();
  });
}
function renderFontList() {
$("font-list").innerHTML = codeFonts().map(
  ([key, name, family]) =>
    `<button role="menuitemradio" class="font-choice" data-font="${key}" aria-checked="false" style="font-family:${esc(family ? family + ", var(--mono-system)" : "var(--mono-system)")}"><span>${esc(name)}</span><span class="sample">${key === "system" ? esc(osName()) : "0O 1lI $t0"}</span></button>`,
).join("");
  // Keep the tick on the chosen font after a re-render.
  $("font-list").querySelectorAll("[data-font]").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.font === codeFont)));
}
renderFontList();
$("font-list").onclick = (e) => {
  const b = e.target.closest("[data-font]");
  if (b) setCodeFont(b.dataset.font);
};
try {
  setCodeFont(localStorage.getItem("code-font") || "jetbrains");
} catch {
  setCodeFont("jetbrains");
}
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
  showContext(CONTEXT_HINT());
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
  notify(t("banner.configChanged"));
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
  const value = parseAddress($("address").value, {
    symbols: program.symbols,
    register: (name) => (state?.registers.some((r) => r.name === canonicalReg(name)) ? regValue(name) : undefined),
  });
  if (value != null) {
    $("address").blur();
    memoryAt(value);
  } else notify(t("memory.invalidAddress"));
};
$("mem-up").onclick = () => shiftMemory(-MEM_STEP);
$("mem-down").onclick = () => shiftMemory(MEM_STEP);
$("mem-expand").onclick = () => setMemMap(!memMapOpen);
document.querySelectorAll("[data-mem-view]").forEach((b) => (b.onclick = () => setMemView(b.dataset.memView)));
// Before anything is assembled the bar is grey and says why.
renderMemoryBar();
// Scrolling past either end of the list moves the window on (classroom
// 2026-11-04: memory should scroll like a document, not page by page).
$("memory").addEventListener(
  "wheel",
  (e) => {
    const m = $("memory");
    if (!state || memShifting) return;
    if (e.deltaY > 0 && m.scrollTop + m.clientHeight >= m.scrollHeight - 2) memShift(MEM_STEP);
    else if (e.deltaY < 0 && m.scrollTop <= 0) memShift(-MEM_STEP);
  },
  { passive: true },
);
let memShifting = false;
function memShift(delta) {
  memShifting = true;
  shiftMemory(delta).finally(() => (memShifting = false));
}
$("add-watch").onclick = () => {
  modal(
    t("watch.add.title"),
    `<form id="watch-form"><input id="watch-target" value="$t0" aria-label="${t("watch.add.target")}"><select id="watch-access"><option value="write">${t("watch.access.write")}</option><option value="read">${t("watch.access.read")}</option><option value="both">${t("watch.add.access")}</option></select><button class="primary">${t("watch.add.button")}</button></form>`,
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
$("example-list").onclick = (e) => {
  const b = e.target.closest("[data-example]");
  if (b) loadExample(Number(b.dataset.example));
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
  run: () => !running && (canRestart() ? restartRun() : run("run")),
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
    chordNote = t("keys.chordPending", { key: keyLabel("Mod+K", mac) });
    notify(chordNote);
    setTimeout(() => {
      const t = keys.expire();
      if (t.hint) hintOnce(t.retiredKey, t.hint);
      else if ($("banner").textContent === chordNote) notify("");
    }, 1600);
    return;
  }
  const typing = e.target.closest?.("input, textarea, .cm-editor");
  // Alt+Left still moves by word inside text on macOS; only explain it elsewhere.
  if (r.hint && !(typing && r.retiredKey === "Alt+ArrowLeft"))
    hintOnce(r.retiredKey, r.hint);
  else if ($("banner").textContent === chordNote) notify("");
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
// An example in the interface language: its copy for that language, else
// English, else whichever copy it has (classroom 2026-11-04).
const exampleCopy = (e) => e.languages?.[language()] || e.languages?.en || Object.values(e.languages || {})[0];
const exampleTitle = (e) => e.title?.[language()] || e.title?.en || e.name;
async function loadExample(index) {
  const e = exampleList[index],
    copy = e && exampleCopy(e);
  if (copy) workspace.example({ files: copy.files, data: copy.data, entry: e.entry || "main.s", assembly: e.assembly }, exampleTitle(e));
}
function selectActiveFile(name) {
  if (name) { switchFile(name); return; }
  savedEditor();
  live.reset();
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
  hasError: (name) => errorReport.list.some((d) => d.file === name && !d.warning),
  sourceFile: () => Object.hasOwn(files,activeFile) ? activeFile : lastSourceFile,
  scopeChanged: () => updateControls(),
  replace: async p => {
    ++commandSerial;
    await requestStop();
    if (busy) throw Error(t("block.wait"));
    lens.close();
    lens.update(null);
    activeFile = "";
    live.reset();
    errorReport = { list: [], sources: {} };
    files = {...p.files}; data = {...p.data};
    lastSourceFile = Object.hasOwn(files,p.activeFile) ? p.activeFile : p.entry;
    runtimeFiles = {};
    fileStates.clear(); navBack.length = navForward.length = 0;
    breakpoints = []; watches = []; debugLog = [];
    state = null; program = {instructions:[], symbols:[], instructionDocs:{}};
    target = null; lastInTarget = ""; inspectingPlace = null; following = true;
    showContext(CONTEXT_HINT());
    inspecting = null; focus = null; inlineCache.key = null;
    dirty = true; pendingResume = null; runMode = "";
    $("delay").checked = p.delay;
    setView("source"); setBottom("console");
    for (const id of ["output","trace","calls","problems","logs","symbols","registers","memory","machine","cfg"]) {
      if ($(id)) $(id).replaceChildren();
    }
    $("history-info").textContent=t("history.empty");
    $("pc").textContent="PC —";
    setMemMap(false); renderMemory();
    selectActiveFile(p.activeFile);
    renderFiles(); renderTabs(); renderStops(); updateControls();
    notify(t("project.updated"));
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
  if (!response.ok) throw Error(t("examples.unavailableNow"));
  exampleList = await response.json();
  renderExamples();
} catch (e) {
  exampleList = null;
  renderExamples();
}
})();
// The example menu, again after a language change.
function renderExamples() {
  if (!exampleList) {
    $("example-list").innerHTML=`<button role="menuitem" disabled>${t("examples.unavailable")}</button>`;
    return;
  }
  $("example-list").innerHTML = exampleList.map((e,i) =>
    `<button role="menuitem" data-example="${i}">${esc(exampleTitle(e))}</button>`
  ).join('') || `<button role="menuitem" disabled>${t("examples.none")}</button>`;
}
// Interface language (classroom 2026-11-03): applies at once; the program,
// its history and the project stay as they are, everything visible redraws.
function renderLanguages() {
  $("language-list").innerHTML = LANGUAGES.map(
    (l) => `<button role="menuitemradio" class="font-choice" data-language="${l.code}" lang="${l.code}" aria-checked="${l.code === language()}">${esc(l.name)}</button>`,
  ).join("");
}
renderLanguages();
$("language-list").onclick = (e) => {
  const b = e.target.closest("[data-language]");
  if (b) setLanguage(b.dataset.language);
};
applyDom();
// Text cut off with "…" (longer languages make this common) shows in full
// on hover, unless the element already has its own tooltip.
document.addEventListener("mouseover", (e) => {
  const el = e.target.closest?.("*");
  if (!el || el.hasAttribute("title") || el.dataset.tip || el.closest(".cm-editor")) return;
  if (el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).textOverflow === "ellipsis") el.title = el.textContent.trim();
});
onLanguageChange(() => {
  renderLanguages();
  renderFontList();
  renderRadixOptions();
  renderExamples();
  labelOverlaySettings();
  updateDemoSpeed();
  setFontSize(fontSize);
  hideTooltip(0);
  workspace?.render();
  renderTabs();
  renderStops();
  if (state) render();
  updateControls();
  if (inspecting) inspectToken(inspecting, inspectingPlace, { refresh: true });
  else followInspector();
  if (lens.isOpen) lens.update(dirty ? null : state);
  tutorial?.update();
  overlay.schedule();
});
