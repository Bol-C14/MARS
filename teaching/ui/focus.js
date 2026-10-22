import { hex, escapeHTML as esc } from "./model.js";
import { layoutPath } from "./path.js";
import { beatModel } from "./beats.js";
// Focus mode (DESIGN §3.7): a floating lens over a blurred IDE that narrates
// the completed step and the predicted path. It owns its own state panel and
// draws every arrow inside itself; machine state only moves through `host`.

const stopText = {
  "waiting-input": "等待输入",
  ended: "程序结束",
  error: "执行异常",
  "instruction-limit": "超过 64 条指令，未继续预计",
};
const BEAT_MS = 900;

export class FocusLens {
  constructor(host) {
    this.host = host;
    this.isOpen = false;
    this.selected = -1;
    this.beat = 0;
    this.whyOpen = false;
    this.expanded = new Set();
    this.mode = this.load("focus-range", "auto");
    this.motion = matchMedia("(prefers-reduced-motion: reduce)");
    document.body.insertAdjacentHTML(
      "beforeend",
      `<div id="focus-backdrop" hidden></div>
      <section id="focus-lens" role="dialog" aria-modal="true" aria-label="专注调试" tabindex="-1" hidden>
        <header id="focus-head">
          <strong>专注</strong><span id="focus-where"></span>
          <label>范围 <select id="focus-range" aria-label="预计范围"><option value="auto">自动</option>${[1, 2, 3, 4, 5, 6, 7, 8].map((n) => `<option value="${n}">${n} 行</option>`).join("")}</select></label>
          <span id="focus-keys">↑↓ 行 · ←→ 拍 · Tab 选步 · Enter 运行到 · ? 推导 · Esc 退出</span>
          <button id="focus-close" aria-label="退出专注模式">×</button>
        </header>
        <div id="focus-body">
          <div id="focus-path" aria-label="代码路径"></div>
          <div id="focus-objects" aria-label="涉及对象"></div>
          <svg id="focus-svg" aria-hidden="true"></svg>
        </div>
        <div id="focus-beat">
          <div class="focus-beat-top"><span id="focus-tag"></span><code id="focus-src"></code><span id="focus-dots" role="group" aria-label="拍"></span></div>
          <div id="focus-eq" aria-live="polite"></div>
          <div id="focus-caption"></div>
          <div class="focus-controls">
            <button id="focus-prev">◀ 上一拍</button><button id="focus-next">下一拍 ▶</button><button id="focus-play">播放</button><button id="focus-why" aria-expanded="false">为什么？</button>
          </div>
          <div id="focus-why-text" hidden></div>
          <form id="focus-input" hidden><label for="focus-input-value">程序在等待输入</label><input id="focus-input-value" autocomplete="off" /><button>提交</button><span>提交后按 ↓ 继续</span></form>
        </div>
      </section>`,
    );
    const $ = (id) => document.getElementById(id);
    this.el = $("focus-lens");
    $("focus-range").value = this.mode;
    $("focus-range").onchange = () => {
      this.mode = $("focus-range").value;
      this.save("focus-range", this.mode);
      this.host.command("state");
    };
    $("focus-close").onclick = () => this.close();
    $("focus-backdrop").onclick = () => this.close();
    $("focus-prev").onclick = () => this.seekBeat(this.beat - 1);
    $("focus-next").onclick = () => this.seekBeat(this.beat + 1);
    $("focus-play").onclick = () => (this.timer ? this.stop() : this.play());
    $("focus-why").onclick = () => this.toggleWhy();
    // The backdrop blocks the IDE console, so input waits are answered here.
    $("focus-input").onsubmit = async (e) => {
      e.preventDefault();
      await this.host.command("input", { value: $("focus-input-value").value });
      $("focus-input-value").value = "";
      this.el.focus();
    };
    window.addEventListener("keydown", (e) => this.key(e), true);
    window.addEventListener("keyup", (e) => {
      if (this.isOpen && this.holding && /^Arrow(Up|Down)$/.test(e.key)) {
        this.holding = false;
        this.autoplay();
      }
    });
    new ResizeObserver(() => this.isOpen && this.draw()).observe(this.el);
    this.drag();
  }

  load(key, fallback) {
    try {
      return localStorage.getItem(key) ?? fallback;
    } catch {
      return fallback;
    }
  }
  save(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch {}
  }

  lookaheadLines() {
    return this.mode === "auto" ? 8 : Number(this.mode);
  }

  async open() {
    if (this.isOpen) return;
    this.isOpen = true;
    this.key_ = null;
    document.getElementById("focus-backdrop").hidden = false;
    this.el.hidden = false;
    document.body.classList.add("focusing");
    this.el.focus();
    await this.host.command("state");
  }

  close() {
    if (!this.isOpen) return;
    this.stop();
    this.isOpen = false;
    document.getElementById("focus-backdrop").hidden = true;
    this.el.hidden = true;
    document.body.classList.remove("focusing");
    this.host.onClose?.();
  }

  // Called after every state change while open. A new position restarts the
  // narration on the completed step unless the machine is running or the user
  // is holding an arrow key.
  update(state) {
    if (!this.isOpen || !state) return;
    const program = this.host.getProgram();
    this.layout = layoutPath({
      last: state.last,
      lookahead: state.lookahead,
      instructions: program.instructions,
      symbols: program.symbols,
      delay: state.delay,
      mode: this.mode === "auto" ? "auto" : "fixed",
      lines: this.lookaheadLines(),
    });
    this.models = new Map(
      this.layout.steps.map((s) => [
        s.index,
        this.stepModel(s, state, program),
      ]),
    );
    const key = `${state.programVersion}:${state.step}:${this.mode}`;
    const moved = key !== this.key_;
    this.key_ = key;
    if (moved || !this.models.has(this.selected)) {
      this.stop();
      this.selected = this.models.has(-1)
        ? -1
        : (this.layout.steps[0]?.index ?? -1);
      this.beat = 0;
    }
    this.render();
    if (moved && !this.host.isRunning() && !this.holding) this.autoplay();
  }

  settle() {
    if (this.isOpen && !this.holding) this.autoplay();
  }

  // One source line may expand to several machine instructions (pseudo-ops):
  // their beats are shown in order under the line's own source text.
  stepModel(step, state, program) {
    const options = { delay: state.delay, ...program };
    const parts = step.events.map((e) => beatModel(e, options));
    if (parts.length === 1) return parts[0];
    const beats = parts.flatMap((p, i) =>
      p.beats.map((b) => ({
        ...b,
        caption: `展开 ${i + 1}/${parts.length} · ${step.events[i].instruction.basic} — ${b.caption}`,
      })),
    );
    const objects = new Map();
    for (const p of parts)
      for (const o of p.objects) {
        const prior = objects.get(o.id);
        objects.set(
          o.id,
          prior
            ? {
                ...prior,
                after: o.after,
                read: prior.read || o.read,
                write: prior.write || o.write,
              }
            : o,
        );
      }
    return {
      template: [
        this.host.getSource(step.file, step.line)?.trim() || parts[0].template,
      ],
      beats,
      summary: parts.at(-1).summary,
      objects: [...objects.values()],
    };
  }

  // ---- narration ----
  autoplay() {
    if (!this.models?.size) return;
    if (this.motion.matches) {
      this.seekBeat(this.current()?.beats.length ?? 0);
      return;
    }
    this.play();
  }
  current() {
    return this.models?.get(this.selected);
  }
  play() {
    const m = this.current();
    if (!m?.beats.length) return;
    this.stop();
    if (this.beat >= m.beats.length) this.beat = 0;
    document.getElementById("focus-play").textContent = "暂停";
    const tick = () => {
      if (this.beat >= m.beats.length) return this.stop();
      this.beat++;
      this.renderBeat(true);
      this.timer = setTimeout(tick, BEAT_MS);
    };
    this.timer = setTimeout(tick, this.beat === 0 ? 250 : BEAT_MS);
    this.renderBeat(false);
  }
  stop() {
    clearTimeout(this.timer);
    this.timer = null;
    const b = document.getElementById("focus-play");
    if (b) b.textContent = "播放";
  }
  seekBeat(n) {
    this.stop();
    const m = this.current();
    this.beat = Math.max(0, Math.min(m?.beats.length ?? 0, n));
    this.renderBeat(true);
  }
  select(index) {
    if (!this.models.has(index)) return;
    this.stop();
    this.selected = index;
    this.beat = 0;
    this.render();
    this.autoplay();
  }
  toggleWhy() {
    this.whyOpen = !this.whyOpen;
    document
      .getElementById("focus-why")
      .setAttribute("aria-expanded", this.whyOpen);
    this.renderBeat(false);
  }

  // ---- keyboard ----
  key(e) {
    if (!this.isOpen) return;
    if (e.target.closest?.("select, input, textarea")) {
      if (e.key === "Escape") this.close();
      return;
    }
    const handled = () => {
      e.preventDefault();
      e.stopPropagation();
    };
    const state = this.host.getState();
    if (e.key === "Escape") {
      handled();
      this.close();
    } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      handled();
      // Holding a key repeats at the OS rate; keep it to about 8 lines a second.
      const now = performance.now();
      if (e.repeat) {
        if (now - (this.lastMove || 0) < 125) return;
        this.holding = true;
        this.stop();
      }
      this.lastMove = now;
      if (!state || this.host.isBusy()) return;
      if (e.key === "ArrowUp") this.host.command("line", { direction: -1 });
      else if (state.step < state.historyLength)
        this.host.command("line", { direction: 1 });
      else if (["paused", "waiting"].includes(state.status))
        this.host.runSource();
    } else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      handled();
      this.seekBeat(this.beat + (e.key === "ArrowLeft" ? -1 : 1));
    } else if (e.key === "Tab") {
      handled();
      const order = this.layout?.steps.map((s) => s.index) || [];
      const i = order.indexOf(this.selected);
      if (order.length)
        this.select(
          order[(i + (e.shiftKey ? -1 : 1) + order.length) % order.length],
        );
    } else if (e.key === "Enter") {
      handled();
      if (this.selected > 0) {
        const n = this.layout.steps
          .filter((s) => s.predicted && s.index < this.selected)
          .reduce((sum, s) => sum + s.events.length, 0);
        this.host.runSteps(n);
      }
    } else if (e.key === "?") {
      handled();
      this.toggleWhy();
    }
  }

  // ---- rendering ----
  render() {
    const $ = (id) => document.getElementById(id),
      state = this.host.getState(),
      L = this.layout;
    $("focus-where").textContent = state
      ? `S${state.step} · ${hex(state.pc)}`
      : "";
    const waiting = state?.status === "waiting";
    if ($("focus-input").hidden === waiting) {
      $("focus-input").hidden = !waiting;
      if (waiting) $("focus-input-value").focus();
    }
    const badge = (s) =>
      `<button class="fbadge ${s.predicted ? "pred" : "done"} ${s.index === this.selected ? "sel" : ""}" data-step="${s.index}" title="${s.predicted ? "预计第 " + (s.index + 1) + " 步" : "刚完成"}">${s.predicted ? "+" + (s.index + 1) : "✓"}</button>`;
    const byIndex = new Map(L.steps.map((s) => [s.index, s]));
    const selectedStep = byIndex.get(this.selected);
    const instructions = this.host.getProgram().instructions;
    $("focus-path").innerHTML =
      L.segments
        .map((seg, n) => {
          const iteration =
            selectedStep?.segment === seg.id ? selectedStep.iteration : null;
          const head = `${esc(seg.label ?? seg.file + ":" + seg.lines[0].line)}${seg.iterations > 1 ? ` <span class="fiter">${iteration ? `第 ${iteration} 次 / ` : ""}共 ${seg.iterations} 次</span>` : ""}`;
          const rows = seg.lines
            .map((line) => {
              const steps = line.steps.map((k) => byIndex.get(k));
              const machine = instructions.filter(
                (i) => i.file === line.file && i.line === line.line,
              );
              const open = this.expanded.has(line.address);
              const hint = L.hints.find(
                (h) => h.segment === seg.id && h.line === line.line,
              );
              const bp = this.host.hasBreakpoint(line.address);
              return `<div class="frow ${steps.some((s) => s.index === this.selected) ? "sel" : ""} ${steps.every((s) => s.predicted) ? "pred" : "done"}" data-row="${line.address}">
                <button class="fbp ${bp ? "on" : ""}" data-bp="${line.address}" aria-label="${bp ? "删除断点" : "设置断点"}">${bp ? "●" : "○"}</button>
                <span class="fln">${line.line}</span>
                <code>${esc(this.host.getSource(line.file, line.line)?.trim() || machine[0]?.basic || "")}</code>
                ${machine.length > 1 ? `<button class="fexpand" data-expand="${line.address}" aria-expanded="${open}">${open ? "▾" : "▸"} ${machine.length} 条</button>` : ""}
                <span class="fbadges">${steps.map(badge).join("")}</span>
              </div>${open ? machine.map((i) => `<div class="fmachine">${hex(i.address)}  ${esc(i.basic)}</div>`).join("") : ""}${hint ? `<div class="fhint">未走：${hint.kind === "taken" ? "→ " + esc(hint.label) : "顺序执行 " + esc(hint.label)}</div>` : ""}`;
            })
            .join("");
          // Staircase: one row per segment in visit order, alternating columns,
          // so every transfer crosses the gutter instead of running down a list.
          return `<div class="fseg" data-seg="${seg.id}" style="grid-column:${(n % 2) + 1};grid-row:${n + 1}"><div class="fseg-head">${head}</div>${rows}</div>`;
        })
        .join("") + this.stopNote();
    $("focus-path")
      .querySelectorAll("[data-step]")
      .forEach((b) => (b.onclick = () => this.select(Number(b.dataset.step))));
    $("focus-path")
      .querySelectorAll(".frow")
      .forEach(
        (row) =>
          (row.onclick = (e) => {
            if (e.target.closest("button")) return;
            const k = row.querySelector("[data-step]");
            if (k) this.select(Number(k.dataset.step));
          }),
      );
    $("focus-path")
      .querySelectorAll("[data-bp]")
      .forEach(
        (b) =>
          (b.onclick = () => {
            this.host.toggleBreakpoint(Number(b.dataset.bp));
            this.render();
          }),
      );
    $("focus-path")
      .querySelectorAll("[data-expand]")
      .forEach(
        (b) =>
          (b.onclick = () => {
            const a = Number(b.dataset.expand);
            this.expanded.has(a)
              ? this.expanded.delete(a)
              : this.expanded.add(a);
            this.render();
          }),
      );
    this.renderBeat(false);
  }

  stopNote() {
    const s = this.layout.stop;
    if (!s.reason) return "";
    const at = s.at?.line ? `（第 ${s.at.line} 行）` : "";
    const text =
      s.reason === "window"
        ? `之后${at}超出范围`
        : `之后：${stopText[s.reason] || "无法预计 · " + s.reason}${at}`;
    return `<div class="fstop" data-anchor="stop">${esc(text)}${s.complete ? "" : " · 该行只预计了一部分"}</div>`;
  }

  // Values of every object the window touches, as of the selected step:
  // recorded before/after for objects it touches, otherwise the last value
  // the window recorded (an object is unchanged until its first access).
  objectValues() {
    const order = this.layout.steps.map((s) => s.index);
    const seen = new Map();
    for (const k of order)
      for (const o of this.models.get(k).objects)
        if (!seen.has(o.id)) seen.set(o.id, { ...o, value: o.before });
    for (const k of order) {
      const m = this.models.get(k);
      for (const o of m.objects) {
        const v = seen.get(o.id);
        if (k === this.selected)
          Object.assign(v, {
            touched: true,
            before: o.before,
            after: o.after,
            write: o.write,
          });
        if (k <= this.selected) v.value = o.after;
      }
      if (k === this.selected) break;
    }
    return [...seen.values()];
  }

  renderBeat(animate) {
    const $ = (id) => document.getElementById(id),
      m = this.current(),
      step = this.layout?.steps.find((s) => s.index === this.selected);
    if (!m || !step) {
      $("focus-eq").textContent = "尚无可解释的步骤";
      $("focus-caption").textContent = "";
      $("focus-dots").innerHTML = "";
      $("focus-objects").innerHTML = "";
      this.draw();
      return;
    }
    const b = this.beat > 0 ? m.beats[this.beat - 1] : null;
    $("focus-tag").textContent = step.predicted
      ? `预计 +${step.index + 1}`
      : "刚完成";
    $("focus-tag").className = step.predicted ? "pred" : "done";
    $("focus-src").textContent =
      `${step.file}:${step.line}  ${this.host.getSource(step.file, step.line)?.trim() || ""}`;
    const parts = b ? b.eq : m.template;
    $("focus-eq").innerHTML = parts
      .map((p) =>
        typeof p === "string"
          ? esc(p)
          : `<span class="${p.c}">${esc(p.t)}</span>`,
      )
      .join("");
    $("focus-caption").textContent = b
      ? b.caption
      : m.beats.length
        ? "→ 下一拍逐个代入真实值"
        : "";
    $("focus-dots").innerHTML = m.beats
      .map(
        (_, i) =>
          `<button class="fdot ${i + 1 < this.beat ? "past" : ""} ${i + 1 === this.beat ? "now" : ""}" data-beat="${i + 1}" aria-label="第 ${i + 1} 拍"></button>`,
      )
      .join("");
    $("focus-dots")
      .querySelectorAll("[data-beat]")
      .forEach(
        (d) => (d.onclick = () => this.seekBeat(Number(d.dataset.beat))),
      );
    $("focus-prev").disabled = this.beat === 0;
    $("focus-next").disabled = this.beat >= m.beats.length;
    $("focus-why").disabled = !b?.why;
    $("focus-why-text").hidden = !(this.whyOpen && b?.why);
    $("focus-why-text").textContent = b?.why || "";

    const objects = this.objectValues(),
      lit = new Map((b?.lit || []).map((l) => [l.id, l.mode]));
    const shown = objects.slice(0, 12);
    const value = (o, n) =>
      o.kind === "memory" && o.width < 4
        ? "0x" +
          ((n >>> 0) & (2 ** (8 * o.width) - 1))
            .toString(16)
            .padStart(2 * o.width, "0")
        : Math.abs(n) >= 10000 || o.kind === "memory"
          ? hex(n)
          : String(n);
    $("focus-objects").innerHTML =
      `<div class="fobj-title">涉及对象</div>` +
      shown
        .map((o) => {
          const label =
            o.kind === "register" ? o.name : `[${hex(o.address)}]·${o.width}B`;
          const v =
            o.touched && o.write && o.before !== o.after
              ? `${value(o, o.before)} → ${value(o, o.after)}`
              : value(o, o.value);
          return `<div class="fobj ${lit.has(o.id) ? "lit-" + lit.get(o.id) : ""} ${o.touched ? "touched" : ""}" data-obj="${o.id}"><span>${esc(label)}</span><span>${esc(v)}</span></div>`;
        })
        .join("") +
      (objects.length > 12
        ? `<div class="fmore">另有 ${objects.length - 12} 个对象</div>`
        : "");
    this.draw(animate ? b : null);
  }

  // ---- drawing inside the lens ----
  anchor(id, side) {
    const body = document.getElementById("focus-body").getBoundingClientRect();
    let el;
    if (id === "code") el = this.rowOf(this.selected);
    else if (id === "next") {
      const order = this.layout.steps.map((s) => s.index);
      const next = order[order.indexOf(this.selected) + 1];
      el =
        next != null
          ? this.rowOf(next)
          : document.querySelector('#focus-path [data-anchor="stop"]');
    } else
      el = document.querySelector(
        `#focus-objects [data-obj="${CSS.escape(id)}"]`,
      );
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (r.width === 0) return null;
    const x =
      side === "right"
        ? r.right - 6
        : side === "left"
          ? r.left + 6
          : r.left + r.width / 2;
    return { x: x - body.left, y: r.top + r.height / 2 - body.top };
  }
  rowOf(index) {
    return document
      .querySelector(`#focus-path [data-step="${index}"]`)
      ?.closest(".frow");
  }
  curve(a, b) {
    const dx = Math.max(40, Math.abs(b.x - a.x) * 0.4);
    return [a, { x: a.x + dx, y: a.y }, { x: b.x - dx, y: b.y }, b];
  }
  // Leave from the side facing the target; between rows of the same column,
  // bow out to the right so the edge never crosses the code.
  route(fr, tr, body) {
    const y = (r) => r.top + r.height / 2 - body.top;
    if (tr.left >= fr.right - 4)
      return this.curve(
        { x: fr.right - body.left, y: y(fr) },
        { x: tr.left - body.left, y: y(tr) },
      );
    if (tr.right <= fr.left + 4)
      return this.curve(
        { x: fr.left - body.left, y: y(fr) },
        { x: tr.right - body.left, y: y(tr) },
      ).map((q, i) =>
        i === 1
          ? { x: fr.left - body.left - 40, y: q.y }
          : i === 2
            ? { x: tr.right - body.left + 40, y: q.y }
            : q,
      );
    const x = Math.max(fr.right, tr.right) - body.left;
    return [
      { x: fr.right - body.left, y: y(fr) },
      { x: x + 48, y: y(fr) },
      { x: x + 48, y: y(tr) },
      { x: tr.right - body.left, y: y(tr) },
    ];
  }
  draw(beatToAnimate) {
    const svg = document.getElementById("focus-svg");
    if (!this.layout) return (svg.innerHTML = "");
    const css = getComputedStyle(document.body),
      color = {
        read: css.getPropertyValue("--blue").trim(),
        write: css.getPropertyValue("--orange").trim(),
        flow: css.getPropertyValue("--purple").trim(),
        edge: css.getPropertyValue("--muted").trim(),
      };
    const path = (p) =>
      `M ${p[0].x} ${p[0].y} C ${p[1].x} ${p[1].y}, ${p[2].x} ${p[2].y}, ${p[3].x} ${p[3].y}`;
    const out = [];
    // Segment edges: from the row that left the segment to the row entered next.
    const order = this.layout.steps;
    for (const e of this.layout.edges) {
      const i = order.findIndex((s) => s.index === e.step);
      if (i < 0 || !order[i + 1]) continue;
      const from = this.rowOf(e.step),
        to = this.rowOf(order[i + 1].index);
      if (!from || !to) continue;
      const body = document
        .getElementById("focus-body")
        .getBoundingClientRect();
      const p = this.route(
        from.getBoundingClientRect(),
        to.getBoundingClientRect(),
        body,
      );
      out.push(
        `<path d="${path(p)}" fill="none" stroke="${color.edge}" stroke-width="1.4" marker-end="url(#farrow-edge)" opacity=".8"/>`,
      );
      const mid = bezier(p, 0.5);
      const label = e.label + (e.count > 1 ? ` ×${e.count}` : "");
      out.push(
        `<g><rect x="${mid.x - label.length * 6 - 4}" y="${mid.y - 9}" width="${label.length * 12 + 8}" height="16" rx="4" fill="var(--panel)" opacity=".95"/><text x="${mid.x}" y="${mid.y + 3}" text-anchor="middle" font-size="11" fill="${color.edge}">${esc(label)}</text></g>`,
      );
    }
    // Current beat: its data and control arrows, solid for the completed step.
    const step = order.find((s) => s.index === this.selected),
      b = this.beat > 0 ? this.current()?.beats[this.beat - 1] : null,
      routes = [];
    for (const t of b?.tokens || []) {
      const from = this.anchor(t.from, t.from === "code" ? "right" : "left"),
        to = this.anchor(t.to, t.to === "code" ? "right" : "left");
      if (!from || !to) continue;
      const p =
        t.to === "next"
          ? this.curve(from, { x: to.x - 10, y: to.y })
          : this.curve(from, to);
      routes.push([p, t]);
      out.push(
        `<path d="${path(p)}" fill="none" stroke="${color[t.kind]}" stroke-width="1.8" ${step?.predicted ? 'stroke-dasharray="5 5"' : ""} marker-end="url(#farrow-${t.kind})"/>`,
      );
    }
    svg.innerHTML =
      `<defs>${Object.entries(color)
        .map(
          ([k, c]) =>
            `<marker id="farrow-${k}" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto"><path d="M0,0 L7,3.5 L0,7" fill="${c}"/></marker>`,
        )
        .join("")}</defs>` + out.join("");
    if (beatToAnimate && !this.motion.matches)
      routes.forEach(([p, t], i) => this.fly(p, t, color[t.kind], i * 90));
  }
  // The one moving thing on screen (P17): the beat's value along its arrow.
  fly(p, t, color, delay) {
    const body = document.getElementById("focus-body");
    body.querySelectorAll(".ftoken").forEach((x) => x.remove());
    const el = document.createElement("div");
    el.className = "ftoken";
    el.textContent = t.label;
    el.style.background = color;
    body.appendChild(el);
    const w = el.offsetWidth / 2,
      h = el.offsetHeight / 2;
    const frames = [0, 0.2, 0.4, 0.6, 0.8, 1].map((s, i, all) => {
      const q = bezier(p, s);
      return {
        transform: `translate(${q.x - w}px, ${q.y - h}px)`,
        opacity: i === 0 || i === all.length - 1 ? 0 : 1,
      };
    });
    el.animate(frames, {
      duration: 700,
      delay,
      easing: "ease-in-out",
      fill: "both",
    }).finished.then(
      () => el.remove(),
      () => el.remove(),
    );
  }

  drag() {
    const head = document.getElementById("focus-head");
    const saved = this.load("focus-position", "");
    if (saved) {
      try {
        const { left, top } = JSON.parse(saved);
        Object.assign(this.el.style, {
          left: left + "px",
          top: top + "px",
          transform: "none",
        });
      } catch {}
    }
    head.addEventListener("pointerdown", (e) => {
      if (e.target.closest("button, select, label")) return;
      const r = this.el.getBoundingClientRect(),
        dx = e.clientX - r.left,
        dy = e.clientY - r.top;
      head.setPointerCapture(e.pointerId);
      const move = (m) => {
        const left = Math.max(0, Math.min(innerWidth - 80, m.clientX - dx)),
          top = Math.max(0, Math.min(innerHeight - 40, m.clientY - dy));
        Object.assign(this.el.style, {
          left: left + "px",
          top: top + "px",
          transform: "none",
        });
      };
      const up = () => {
        head.removeEventListener("pointermove", move);
        head.removeEventListener("pointerup", up);
        const r2 = this.el.getBoundingClientRect();
        this.save(
          "focus-position",
          JSON.stringify({ left: r2.left, top: r2.top }),
        );
        this.draw();
      };
      head.addEventListener("pointermove", move);
      head.addEventListener("pointerup", up);
    });
  }
}

function bezier([a, b, c, d], t) {
  const u = 1 - t;
  return {
    x:
      u * u * u * a.x +
      3 * u * u * t * b.x +
      3 * u * t * t * c.x +
      t * t * t * d.x,
    y:
      u * u * u * a.y +
      3 * u * u * t * b.y +
      3 * u * t * t * c.y +
      t * t * t * d.y,
  };
}
