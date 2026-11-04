import { t, localized } from "./i18n/index.js";
// Hands-on introduction (classroom 2026-10-24): a Hello World program that
// grows into reading a name, debugging it, finding an integer overflow, and
// adding a feature of one's own. Each step starts from a goal or a question
// and is checked against what actually happened in the IDE (files, the
// loaded program, output, breakpoints, watchpoints, the inspector, focus
// mode), never by counting clicks on "next". Hints come one at a time; the
// reference answer is shown, never typed into the student's code.
import { escapeHTML as esc } from "./model.js";

const HELLO = () => `.data
greeting: .asciiz "Hello!"
${t("tutorial.code.hello")}`;
const NAME = () => `.data
greeting: .asciiz "Hello, "
bang:     .asciiz "!"
${t("tutorial.code.name")}`;
const OVERFLOW = () => `    ${t("tutorial.code.overflow")}`;
const AGE = () => `    ${t("tutorial.code.age")}`;

const traceOf = (c) => (c.state?.trace || []).filter((e) => e.step <= (c.state?.step ?? 0));
const ranFrom = (c, file) => !!c.target?.files.includes(file) && !c.dirty;
const reg = (c, name) => c.state?.registers?.find((r) => r.name === name)?.value;
const nextIsSyscall = (c, service) => {
  const p = c.state?.preview?.instruction;
  return p?.op === "syscall" && reg(c, "$v0") === service;
};

// Each step: stage, title, goal (the question), checks [label, (ctx, memo) => bool],
// hints, answer, go: [label, action name] for "show me where".
export const STEPS = localized(() => ([
  {
    stage: t("tutorial.stage1"),
    title: t("tutorial.s1.title"),
    goal: t("tutorial.s1.goal"),
    checks: [[t("tutorial.s1.check"), (c) => Object.hasOwn(c.files, "hello.s")]],
    hints: [t("tutorial.s1.hint1"), t("tutorial.s1.hint2")],
    go: [[t("tutorial.go.files"), "side:files"]],
  },
  {
    stage: t("tutorial.stage1"),
    title: t("tutorial.s2.title"),
    goal: t("tutorial.s2.goal"),
    checks: [
      [t("tutorial.s2.check1"), (c) => ranFrom(c, "hello.s")],
      [t("tutorial.s2.check2"), (c) => ranFrom(c, "hello.s") && c.state?.status === "ended"],
      [t("tutorial.s2.check3"), (c) => ranFrom(c, "hello.s") && (c.state?.output || "").includes("Hello!")],
    ],
    hints: [
      t("tutorial.s2.hint1"),
      t("tutorial.s2.hint2"),
    ],
    answer: HELLO(),
    go: [[t("tutorial.go.printString"), t("tutorial.go.printString.query")]],
  },
  {
    stage: t("tutorial.stage2"),
    title: t("tutorial.s3.title"),
    goal: t("tutorial.s3.goal"),
    checks: [
      [t("tutorial.s3.check1"), (c) => ranFrom(c, "hello.s") && traceOf(c).some((e) => e.service === 8 && e.instruction.op === "syscall" && e.status !== "waiting-input")],
      [t("tutorial.s3.check2"), (c) => {
        const out = c.state?.output || "", typed = (c.state?.inputEchoes || []).map((e) => e.text ?? e.value ?? "").filter(Boolean);
        return ranFrom(c, "hello.s") && out.includes("Hello, ") && typed.some((t) => out.includes(String(t).trim()));
      }],
    ],
    hints: [
      t("tutorial.s3.hint1"),
      t("tutorial.s3.hint2"),
      t("tutorial.s3.hint3"),
    ],
    answer: NAME(),
    doneNote: t("tutorial.s3.note"),
    go: [[t("tutorial.go.readString"), t("tutorial.go.readString.query")]],
  },
  {
    stage: t("tutorial.stage3"),
    title: t("tutorial.s4.title"),
    goal: t("tutorial.s4.goal"),
    checks: [
      [t("tutorial.s4.check1"), (c) => c.breakpoints.some((b) => b.address != null)],
      [t("tutorial.s4.check2"), (c) => /^Breakpoint/.test(c.state?.stopReason || "") && nextIsSyscall(c, 4)],
    ],
    hints: [t("tutorial.s4.hint1"), t("tutorial.s4.hint2")],
    go: [[t("tutorial.go.stops"), "side:stops"]],
  },
  {
    stage: t("tutorial.stage3"),
    title: t("tutorial.s5.title"),
    goal: t("tutorial.s5.goal"),
    checks: [[t("tutorial.s5.check"), (c) => c.inspecting === "syscall"]],
    hints: [t("tutorial.s5.hint1"), t("tutorial.s5.hint2")],
    go: [[t("tutorial.go.inspector"), "panel:context"]],
  },
  {
    stage: t("tutorial.stage3"),
    title: t("tutorial.s6.title"),
    goal: t("tutorial.s6.goal"),
    checks: [[t("tutorial.s6.check"), (c) => {
      const a = reg(c, "$a0") >>> 0, base = (c.state?.memoryBase ?? -1) >>> 0;
      return a >= base && a < base + (c.state?.memory?.length || 0);
    }]],
    hints: [t("tutorial.s6.hint1"), t("tutorial.s6.hint2")],
    go: [[t("tutorial.go.a0"), "inspect:$a0"]],
  },
  {
    stage: t("tutorial.stage3"),
    title: t("tutorial.s7.title"),
    goal: t("tutorial.s7.goal"),
    checks: [[t("tutorial.s7.check"), (c, memo) => memo.lensSyscall]],
    hints: [t("tutorial.s7.hint1"), t("tutorial.s7.hint2")],
    go: [[t("tutorial.go.focus"), "focus"]],
  },
  {
    stage: t("tutorial.stage4"),
    title: t("tutorial.s8.title"),
    goal: t("tutorial.s8.goal"),
    checks: [[t("tutorial.s8.check"), (c, memo) => memo.overflowStep != null]],
    hints: [t("tutorial.s8.hint1"), t("tutorial.s8.hint2")],
    code: OVERFLOW(),
  },
  {
    stage: t("tutorial.stage4"),
    title: t("tutorial.s9.title"),
    goal: t("tutorial.s9.goal"),
    checks: [
      [t("tutorial.s9.check1"), (c, memo) => memo.overflowStep != null && (c.state?.step ?? Infinity) < memo.overflowStep],
      [t("tutorial.s9.check2"), (c) => !!c.inspecting && !c.inspecting.startsWith("$") && c.inspecting !== "syscall"],
    ],
    hints: [t("tutorial.s9.hint1"), t("tutorial.s9.hint2")],
  },
  {
    stage: t("tutorial.stage4"),
    title: t("tutorial.s10.title"),
    goal: t("tutorial.s10.goal"),
    checks: [
      [t("tutorial.s10.check1"), (c) => c.watches.some((w) => w.register === "$t0" && w.access === "write")],
      [t("tutorial.s10.check2"), (c) => /^Watchpoint/.test(c.state?.stopReason || "")],
    ],
    hints: [t("tutorial.s10.hint1"), t("tutorial.s10.hint2")],
    go: [[t("tutorial.go.stops"), "side:stops"]],
  },
  {
    stage: t("tutorial.stage4"),
    title: t("tutorial.s11.title"),
    goal: t("tutorial.s11.goal"),
    checks: [[t("tutorial.s11.check1"), (c) => c.state?.status === "ended" && !c.state?.error],
      [t("tutorial.s11.check2"), (c, memo) => memo.fixed === true]],
    hints: [t("tutorial.s11.hint1"), t("tutorial.s11.hint2")],
    fail: (c, memo) => (memo.fixed === false ? t("tutorial.s11.fail") : ""),
  },
  {
    stage: t("tutorial.stage5"),
    title: t("tutorial.s12.title"),
    goal: t("tutorial.s12.goal"),
    checks: [[t("tutorial.s12.check"), (c) => {
      const read = traceOf(c).filter((e) => e.service === 5 && e.instruction.op === "syscall").map((e) => e.accesses.find((a) => a.write && a.name === "$v0")?.value).filter((v) => v != null);
      return read.some((n) => (c.state?.output || "").includes(String(n + 1)));
    }]],
    hints: [t("tutorial.s12.hint1"), t("tutorial.s12.hint2")],
    answer: AGE(),
    go: [[t("tutorial.go.readInt"), t("tutorial.go.readInt.query")]],
  },
  {
    stage: t("tutorial.stage5"),
    title: t("tutorial.s13.title"),
    goal: t("tutorial.s13.goal"),
    checks: [[t("tutorial.s13.check"), (c, memo) => memo.exported]],
    hints: [t("tutorial.s13.hint")],
    go: [[t("tutorial.go.projectMenu"), "menu:project"]],
  },
]));

export class Tutorial {
  constructor(host) {
    this.host = host;
    this.memo = {};
    this.index = 0;
    this.shown = 0;
    this.answer = false;
    document.body.insertAdjacentHTML(
      "beforeend",
      `<section id="tutorial" class="tutorial" role="complementary" aria-label="${t("menu.learn.tutorial")}" data-i18n-aria-label="menu.learn.tutorial" hidden></section>`,
    );
    this.el = document.getElementById("tutorial");
    try {
      const saved = JSON.parse(localStorage.getItem("tutorial") || "null");
      if (saved?.active) {
        Object.assign(this, { index: saved.index || 0, memo: saved.memo || {}, collapsed: !!saved.collapsed });
        this.active = true;
      }
    } catch {}
  }
  save() {
    try {
      localStorage.setItem("tutorial", JSON.stringify({ active: this.active, index: this.index, memo: this.memo, collapsed: this.collapsed }));
    } catch {}
  }
  start() {
    this.active = true;
    this.index = 0;
    this.memo = {};
    this.shown = 0;
    this.answer = false;
    this.collapsed = false;
    this.save();
    this.update();
  }
  stop() {
    this.active = false;
    this.save();
    this.el.hidden = true;
  }
  // Facts the checks remember across states: an overflow happened at step N;
  // a syscall ran while focus mode was open; the fix kept arithmetic exact.
  observe(c) {
    const s = c.state;
    if (!s) return;
    const last = s.last;
    if (s.status === "error" && /overflow/i.test(s.error || last?.error || "")) this.memo.overflowStep = s.step;
    if (c.lensOpen && last?.instruction?.op === "syscall" && s.step !== this.memo.lensFrom) this.memo.lensSyscall = true;
    if (!c.lensOpen) this.memo.lensFrom = s.step;
    if (s.status === "ended" && !s.error) {
      const adds = (s.trace || []).filter((e) => /^addi?u?$/.test(e.instruction.op) && e.accesses.some((a) => a.write && a.name === "$t0"));
      const e = adds.at(-1);
      if (e) {
        const before = e.accesses.find((a) => !a.write && a.name === "$t0")?.value,
          after = e.accesses.find((a) => a.write && a.name === "$t0")?.value,
          imm = (e.instruction.binary << 16) >> 16;
        if (before != null && /i/.test(e.instruction.op)) this.memo.fixed = before + imm === after;
      }
    }
  }
  update() {
    if (!this.active) return (this.el.hidden = true);
    const c = this.host.context();
    this.observe(c);
    const step = STEPS[this.index],
      results = step.checks.map(([label, f]) => [label, !!f(c, this.memo)]),
      done = results.every(([, ok]) => ok),
      fail = step.fail?.(c, this.memo) || "";
    if (done && !this.memo["done" + this.index]) this.memo["done" + this.index] = true;
    this.save();
    this.el.hidden = false;
    this.el.classList.toggle("collapsed", !!this.collapsed);
    const progress = `${this.index + 1}/${STEPS.length}`;
    if (this.collapsed) {
      this.el.innerHTML = `<button class="tutorial-pill" data-t="expand">${t("tutorial.card.title", { progress, done: done ? " ✓" : "" })}</button>`;
    } else
      this.el.innerHTML = `<header><b>${t("menu.learn.tutorial")}</b><span>${t("tutorial.card.stage", { stage: esc(step.stage), progress })}</span><button data-t="collapse" aria-label="${t("tutorial.card.collapse")}">—</button><button data-t="exit" aria-label="${t("tutorial.card.exit")}">×</button></header>
      <h4>${esc(step.title)}</h4><p class="tutorial-goal">${esc(step.goal)}</p>
      <ul class="tutorial-checks">${results.map(([label, ok]) => `<li class="${ok ? "ok" : ""}">${ok ? "✓" : "○"} ${esc(label)}</li>`).join("")}</ul>
      ${fail ? `<p class="tutorial-fail" role="alert">${esc(fail)}</p>` : ""}
      ${done && step.doneNote ? `<p class="tutorial-hint">${esc(step.doneNote)}</p>` : ""}
      ${step.code ? `<pre class="tutorial-answer">${esc(step.code)}</pre>` : ""}
      ${step.hints.slice(0, this.shown).map((h, i) => `<p class="tutorial-hint">${t("tutorial.card.hint", { n: i + 1, hint: esc(h) })}</p>`).join("")}
      ${this.answer && step.answer ? `<p class="tutorial-hint">${t("tutorial.card.answer.note")}</p><pre class="tutorial-answer">${esc(step.answer)}</pre>` : ""}
      <div class="tutorial-go">${(step.go || []).map(([label, action]) => `<button data-go="${esc(action)}">${esc(label)}</button>`).join("")}</div>
      <div class="tutorial-actions">${this.shown < step.hints.length ? `<button data-t="hint">${this.shown ? t("tutorial.card.moreHint") : t("tutorial.card.hintButton")}</button>` : ""}${step.answer && !this.answer ? `<button data-t="answer">${t("tutorial.card.answer")}</button>` : ""}<span></span><button data-t="prev" ${this.index ? "" : "disabled"}>${t("tutorial.card.back")}</button>${done ? `<button class="primary" data-t="next">${this.index === STEPS.length - 1 ? t("tutorial.card.finish") : t("tutorial.card.next")}</button>` : `<button data-t="skip" title="${t("tutorial.card.skip.tip")}">${t("tutorial.card.skip")}</button>`}</div>`;
    this.el.querySelectorAll("[data-t]").forEach((b) => (b.onclick = () => this.act(b.dataset.t)));
    this.el.querySelectorAll("[data-go]").forEach((b) => (b.onclick = () => this.host.go(b.dataset.go)));
  }
  act(a) {
    if (a === "hint") this.shown++;
    else if (a === "answer") this.answer = true;
    else if (a === "collapse" || a === "expand") this.collapsed = a === "collapse";
    else if (a === "exit") return this.host.finish(false);
    else if (a === "prev" || a === "next" || a === "skip") {
      if (a === "next" && this.index === STEPS.length - 1) return this.host.finish(true);
      this.index = Math.max(0, Math.min(STEPS.length - 1, this.index + (a === "prev" ? -1 : 1)));
      this.shown = 0;
      this.answer = false;
    }
    this.save();
    this.update();
  }
}
