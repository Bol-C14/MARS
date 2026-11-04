import { t, localized } from "./i18n/index.js";
// Per-service syscall teaching (classroom 2026-10-24): what a service does,
// which registers it reads and what they mean, what happens, and which
// registers or terminal change. Mechanism only; values come from the caller.
import { escapeByte } from "./radix.js";

// [name, what it does, [[register, meaning]], what happens, what changes]
export const serviceGuide = localized(() => ({
  1: [t("service.1"), t("guide.1.does"), [["$a0", t("guide.arg.intToPrint")]], t("guide.1.effect"), t("guide.changes.terminal")],
  2: [t("service.2"), t("guide.2.does"), [["$f12", t("guide.arg.numberToPrint")]], t("guide.2.effect"), t("guide.changes.terminal")],
  3: [t("service.3"), t("guide.3.does"), [["$f12", t("guide.arg.doubleLow")]], t("guide.2.effect"), t("guide.changes.terminal")],
  4: [t("guide.4.name"), t("guide.4.does"), [["$a0", t("guide.arg.stringAddress")]], t("guide.4.effect"), t("guide.changes.terminal")],
  5: [t("service.5"), t("guide.5.does"), [], t("guide.5.effect"), t("guide.changes.v0")],
  6: [t("service.6"), t("guide.readFloat.does"), [], t("guide.6.effect"), t("guide.changes.f0")],
  7: [t("service.7"), t("guide.readFloat.does"), [], t("guide.7.effect"), t("guide.changes.f0f1")],
  8: [t("service.8"), t("guide.8.does"), [["$a0", t("guide.arg.bufferAddress")], ["$a1", t("guide.arg.bufferSize")]], t("guide.8.effect"), t("guide.changes.memory")],
  9: [t("service.9"), t("guide.9.does"), [["$a0", t("guide.arg.bytesNeeded")]], t("guide.9.effect"), t("guide.changes.v0")],
  10: [t("service.10"), t("guide.10.does"), [], t("guide.10.effect"), t("guide.changes.ended")],
  11: [t("service.11"), t("guide.11.does"), [["$a0", t("guide.arg.charCode")]], t("guide.11.effect"), t("guide.changes.terminal")],
  12: [t("service.12"), t("guide.12.does"), [], t("guide.12.effect"), t("guide.changes.v0")],
  13: [t("service.13"), t("guide.13.does"), [["$a0", t("guide.arg.fileName")], ["$a1", t("guide.arg.openFlags")], ["$a2", t("guide.arg.mode")]], t("guide.13.effect"), t("guide.changes.v0")],
  14: [t("service.14"), t("guide.14.does"), [["$a0", t("guide.arg.fd")], ["$a1", t("guide.arg.buffer")], ["$a2", t("guide.arg.maxRead")]], t("guide.14.effect"), t("guide.changes.memoryV0")],
  15: [t("service.15"), t("guide.15.does"), [["$a0", t("guide.arg.fd")], ["$a1", t("guide.arg.dataAddress")], ["$a2", t("guide.arg.byteCount")]], t("guide.15.effect"), t("guide.changes.fileV0")],
  16: [t("service.16"), t("guide.16.does"), [["$a0", t("guide.arg.fd")]], t("guide.16.effect"), t("common.none")],
  17: [t("service.17"), t("guide.17.does"), [["$a0", t("guide.arg.exitCode")]], t("guide.17.effect"), t("guide.changes.ended")],
  34: [t("service.34"), t("guide.34.does"), [["$a0", t("guide.arg.intToPrint")]], t("guide.34.effect"), t("guide.changes.terminal")],
  35: [t("service.35"), t("guide.35.does"), [["$a0", t("guide.arg.intToPrint")]], t("guide.35.effect"), t("guide.changes.terminal")],
  36: [t("service.36"), t("guide.36.does"), [["$a0", t("guide.arg.intToPrint")]], t("guide.36.effect"), t("guide.changes.terminal")],
}));
const printable = (b) => b >= 32 && b < 127;

// What a parameter value means for this service, e.g. 45 → '-' for service 11.
export function argumentMeaning(n, register, value) {
  if (value == null) return "";
  if (n === 11 && register === "$a0") {
    const b = value & 255;
    return printable(b) ? t("guide.meaning.char", { code: b, char: escapeByte(b) }) : t("guide.meaning.notPrintable", { code: b, char: escapeByte(b) });
  }
  if (n === 1 && register === "$a0") return t("guide.meaning.prints", { value: value | 0 });
  if (n === 36 && register === "$a0") return t("guide.meaning.prints", { value: value >>> 0 });
  if ((n === 4 || n === 8 || n === 13) && register === "$a0") return t("guide.meaning.address");
  if ((n === 14 || n === 15) && register === "$a1") return t("guide.meaning.address");
  return "";
}

// What a syscall line will do is chosen by the value in $v0 (round-4
// trial: "服务号" was a word students had to learn first, so the IDE says
// "$v0 = 5 选定了读取整数" instead). This finds that value and where it was
// put: the current $v0 for the line about to run, the recorded value from
// before the call for a line that ran (a read overwrites $v0 afterwards),
// else the nearest `li $v0, N` above within the same straight-line code.
// `setter` is that li line, when there is one with the same value.
export function serviceAt({ next, event, v0, lines = [], line = 0 }) {
  let setter = null;
  for (let i = line - 2; i >= 0 && i >= line - 30; i--) {
    const text = lines[i].replace(/#.*/, "");
    const m = /^\s*(?:li|addiu?|ori)\s+\$(?:v0|2)\s*,\s*(?:\$(?:zero|0)\s*,\s*)?(-?(?:0x[\da-f]+|\d+))\s*$/i.exec(text);
    if (m) {
      setter = { n: Number(m[1]), line: i + 1, text: text.trim() };
      break;
    }
    if (/^\s*[\w.$]+\s*:/.test(text) || /^\s*(?:j|jal|jr|jalr|b\w*)\s/.test(text) || /^\s*syscall\b/.test(text) || /\$(?:v0|2)\s*,/.test(text)) break;
  }
  const n = next ? v0 : event ? event.service : setter ? setter.n : null;
  return { n, from: next ? "next" : event ? "ran" : setter ? "source" : "unknown", event, setter: setter?.n === n ? setter : null };
}
// One sentence for where the value came from; the same for a line about to
// run, one that ran, or one not reached yet.
function chosenBy(n, name, setter, step) {
  if (n == null) return t("guide.chosen.unknown");
  const where = setter ? t("guide.chosen.setter", { line: setter.line, code: setter.text, when: step ? t("guide.chosen.step", { step }) : "" }) : "";
  return t("guide.chosen", { n, name, where });
}

// The detailed explanation of one syscall: what it does → its parameters with
// their values and meaning → what happened (or will) → what changes.
// `values` maps registers to the values the call reads (or null when they
// are not known yet); `event` is the recorded execution, if any.
export function syscallDetail({ n, values = {}, event, waiting, esc, show = String, regTitle = null, setter = null, step = null }) {
  // A register name, hoverable for its conventional use when the caller can say it.
  const reg = (r) => (regTitle ? `<abbr class="reg-term" title="${esc(regTitle(r))}">${r}</abbr>` : r);
  const g = serviceGuide[n];
  const head = n == null ? t("guide.title.unknown") : `syscall${t("common.colon")}${g ? g[0] : t("guide.title.unsupported")}`;
  if (n != null && !g)
    return { title: head, html: `<p>${t("guide.unsupported", { n: esc(String(n)), supported: Object.keys(serviceGuide).join(t("common.listSep")) })}</p>` };
  if (!g) return { title: head, html: `<p>${esc(chosenBy(null))}</p>` };
  const [, does, args, effect, changes] = g;
  const arg = ([r, meaning]) => {
    const v = values[r], m = argumentMeaning(n, r, v);
    return `<li><code>${reg(r)}</code> ${esc(meaning)}${v == null ? "" : ` = <b>${esc(show(v, r))}</b>`}${m ? `<small> · ${esc(m)}</small>` : ""}</li>`;
  };
  const happened = [];
  if (waiting) happened.push(t("guide.waiting", { n }));
  if (event) {
    if (event.output) happened.push(`${t("guide.output")} "${esc([...event.output].map((c) => escapeByte(c.charCodeAt(0))).join(""))}"`);
    for (const a of event.accesses || [])
      if (a.write && a.kind === "register") happened.push(t("guide.registerChanged", { name: a.name, value: esc(show(a.value, a.name)) }));
    const bytes = (event.accesses || []).filter((a) => a.kind === "memory" && a.write).reduce((s, a) => s + a.width, 0);
    if (bytes) happened.push(t("guide.memoryWritten", { bytes }));
    if (event.status === "waiting-input") happened.push(t("guide.wasWaiting"));
  }
  return {
    title: head,
    html: `<p class="syscall-chosen">${esc(chosenBy(n, g[0], setter, step))}</p><dl class="syscall-steps"><dt>${t("guide.heading.does")}</dt><dd>${esc(does)}</dd><dt>${t("guide.heading.args")}</dt><dd>${args.length ? `<ul>${args.map(arg).join("")}</ul>` : t("common.none")}</dd><dt>${t("guide.heading.effect")}</dt><dd>${esc(effect)}${happened.length ? `<ul>${happened.map((h) => `<li>${h}</li>`).join("")}</ul>` : ""}</dd><dt>${t("guide.heading.changes")}</dt><dd>${esc(changes)}</dd></dl>`,
  };
}
