import { hex, escapeHTML as esc } from "./model.js";
const value = (n) => `${n} (${hex(n)})`;
const object = (a) =>
  a.kind === "register" ? a.name : `[${hex(a.address)}] · ${a.width} 字节`;
export function explain(event) {
  if (!event?.instruction) return [];
  const actions = [],
    accesses = event.accesses || [];
  const add = (title, detail, entries = [], kind = "read") =>
    actions.push({ title, detail, accesses: entries, kind });
  const reads = accesses.filter((a) => a.kind === "register" && !a.write);
  const unique = [...new Map(reads.map((a) => [a.name, a])).values()];
  if (event.service != null)
    add(
      "选择服务",
      `syscall ${event.service} · ${{ 1: "输出整数", 4: "输出字符串", 5: "读取整数", 8: "读取字符串", 9: "申请堆内存", 10: "结束程序", 11: "输出字符", 12: "读取字符", 13: "打开文件", 14: "读取文件", 15: "写入文件", 16: "关闭文件", 17: "带返回码退出" }[event.service] || "系统服务"}`,
      unique,
    );
  else if (unique.length)
    add(
      "读取操作数",
      unique.map((a) => `${a.name} = ${value(a.value)}`).join("；"),
      unique,
    );
  const bits = event.instruction.binary,
    rs = (bits >>> 21) & 31,
    rt = (bits >>> 16) & 31;
  const reg = (n) => reads.find((a) => a.number === n);
  const x = reg(rs),
    y = reg(rt),
    imm = (bits << 16) >> 16;
  const result = accesses.find((a) => a.kind === "register" && a.write);
  const symbols = {
    add: "+",
    addu: "+",
    sub: "−",
    subu: "−",
    and: "&",
    or: "|",
    xor: "^",
    slt: "<",
    sltu: "< (无符号)",
  };
  const opName = event.instruction.op;
  if (result && x && symbols[opName] && y)
    add(
      "计算",
      `${x.name} (${x.value}) ${symbols[opName]} ${y.name} (${y.value}) = ${value(result.value)}`,
      [x, y],
      "compute",
    );
  if (result && x && ["addi", "addiu"].includes(opName))
    add(
      "计算",
      `${x.name} (${x.value}) + (${imm}) = ${value(result.value)}`,
      [x],
      "compute",
    );
  if (x && y && ["beq", "bne"].includes(opName))
    add(
      "判断条件",
      `${x.name} (${x.value}) ${opName === "beq" ? "==" : "≠"} ${y.name} (${y.value}) → ${(opName === "beq" ? x.value === y.value : x.value !== y.value) ? "成立" : "不成立"}`,
      [x, y],
      "compute",
    );
  const mem = accesses.find((a) => a.kind === "memory");
  const op = event.instruction.op;
  if (mem && /^(lb|lbu|lh|lhu|lw|sb|sh|sw)$/.test(op)) {
    const bits = event.instruction.binary,
      base = (bits >>> 21) & 31,
      offset = (bits << 16) >> 16;
    const r = reads.find((a) => a.number === base);
    if (r)
      add(
        "计算地址",
        `${r.name} ${hex(r.value)} + (${offset}) = ${hex((r.value + offset) | 0)}`,
        [r],
        "compute",
      );
  }
  // Preserve observed memory/write ordering; do not invent intermediate CPU states.
  let group = [];
  const flush = () => {
    if (!group.length) return;
    const a = group[0];
    add(
      a.write ? "写入" : "读取内存",
      group
        .map(
          (x) =>
            `${object(x)}: ${x.write ? value(x.before) + " → " : ""}${value(x.value)}`,
        )
        .join("；"),
      group,
      a.write ? "write" : "read",
    );
    group = [];
  };
  for (const a of accesses) {
    if (a.kind === "register" && !a.write) continue;
    if (
      group.length &&
      (group[0].kind !== a.kind ||
        group[0].write !== a.write ||
        group.length >= 8)
    )
      flush();
    group.push(a);
  }
  flush();
  if (event.output) add("程序输出", JSON.stringify(event.output), [], "effect");
  if (event.status === "waiting-input")
    add("等待输入", "结果尚未产生。请在控制台提交输入。", [], "effect");
  if (event.error) add("执行异常", event.error, [], "effect");
  if (event.nextPC != null)
    add(
      "执行位置",
      `下一条 PC = ${hex(event.nextPC)}${event.instruction.flow === "branch" ? " · 根据本次比较与延迟分支设置" : ""}`,
      [],
      "flow",
    );
  return actions;
}
export class ActionPlayer {
  constructor({ onChange, onObject }) {
    this.onChange = onChange;
    this.onObject = onObject;
    this.index = -1;
    this.layer = "last";
    document.querySelector(".execution-strip").insertAdjacentHTML(
      "afterend",
      `<section id="action-player" aria-label="指令动作解释">
      <div class="action-toolbar"><strong>这一步发生了什么</strong><button id="action-toggle" aria-expanded="true" hidden>收起解释</button><select hidden id="action-layer" aria-label="解释步骤"><option value="last">已执行 · 实线</option><option value="preview">下一步预计 · 虚线</option></select><span id="action-status"></span></div>
      <div id="action-body"><div id="action-summary"></div><details id="action-advanced"><summary>查看动作细节</summary><div class="action-toolbar"><button id="action-prev">上一动作</button><button id="action-play">播放解释</button><button id="action-next">下一动作</button><select id="action-speed" aria-label="播放速度"><option value="1200">慢速</option><option value="700" selected>标准</option><option value="350">快速</option></select><label><input id="action-auto" type="checkbox">单步后播放</label></div><div id="action-steps" aria-label="动作列表"></div></details><div id="action-detail" tabindex="0" aria-live="polite"></div></div></section>`,
    );
    const $ = (id) => document.getElementById(id);
    $("action-layer").onchange = () => {
      this.stop();
      this.layer = $("action-layer").value;
      this.selectEvent();
    };
    $("action-prev").onclick = () => this.seek(Math.max(0, this.index - 1));
    $("action-next").onclick = () =>
      this.seek(Math.min(this.actions.length - 1, this.index + 1));
    $("action-play").onclick = () => (this.timer ? this.stop() : this.play());
    $("action-speed").onchange = () => {
      if (this.timer) {
        this.stop();
        this.play();
      }
    };
    $("action-toggle").onclick = () => {
      const b = $("action-body");
      b.hidden = !b.hidden;
      $("action-toggle").textContent = b.hidden ? "展开解释" : "收起解释";
      $("action-toggle").setAttribute("aria-expanded", !b.hidden);
      if (b.hidden) this.stop();
      this.onChange();
    };
    this.motion = matchMedia("(prefers-reduced-motion: reduce)");
    this.motion.addEventListener("change", () => {
      if (this.motion.matches) this.stop();
    });
  }
  update(state, { autoplay = false } = {}) {
    const key = JSON.stringify([
      state?.programVersion,
      state?.last,
      state?.preview,
    ]);
    if (key === this.key) {
      if (
        autoplay &&
        document.getElementById("action-auto").checked &&
        !this.motion.matches &&
        !document.getElementById("action-body").hidden
      ) {
        this.layer = "last";
        this.selectEvent();
        this.play();
      }
      return;
    }
    this.stop();
    this.key = key;
    this.state = state;
    this.layer = state?.last ? "last" : "preview";
    this.selectEvent();
    if (
      autoplay &&
      document.getElementById("action-auto").checked &&
      !this.motion.matches &&
      !document.getElementById("action-body").hidden
    )
      this.play();
  }
  selectEvent() {
    this.event = this.state?.[this.layer];
    this.actions = explain(this.event);
    this.index = 0;
    document.getElementById("action-layer").value = this.layer;
    this.render();
  }
  stop() {
    clearTimeout(this.timer);
    this.timer = null;
    document.getElementById("action-play").textContent = "播放解释";
  }
  seek(i) {
    this.stop();
    this.index = i;
    this.render();
  }
  play() {
    if (!this.actions.length) return;
    this.index =
      this.index >= this.actions.length - 1 ? 0 : Math.max(0, this.index);
    const tick = () => {
      this.render();
      document.getElementById("action-play").textContent = "暂停解释";
      this.timer = setTimeout(
        () => {
          if (this.index >= this.actions.length - 1) {
            this.stop();
            return;
          }
          this.index++;
          tick();
        },
        Number(document.getElementById("action-speed").value),
      );
    };
    tick();
  }
  selection() {
    return document.getElementById("action-body").hidden
      ? null
      : { layer: this.layer, action: this.actions?.[this.index] };
  }
  render() {
    const $ = (id) => document.getElementById(id),
      a = this.actions[this.index],
      preview = this.layer === "preview";
    $("action-status").textContent =
      `${preview ? "即将执行" : "刚刚执行 · 下方为过程回放"}${a ? " · 动作 " + (this.index + 1) + "/" + this.actions.length : ""}`;
    $("action-summary").textContent = this.event?.instruction
      ? `${this.event.instruction.source?.trim() || this.event.instruction.basic} · ${this.event.instruction.file}:${this.event.instruction.line}`
      : "尚无执行记录";
    $("action-steps").innerHTML = this.actions
      .map(
        (x, i) =>
          `<button data-action-index="${i}" aria-pressed="${i === this.index}" class="${i === this.index ? "selected" : ""}">${i + 1} ${esc(x.title)}</button>`,
      )
      .join("");
    $("action-steps")
      .querySelectorAll("button")
      .forEach(
        (b) => (b.onclick = () => this.seek(Number(b.dataset.actionIndex))),
      );
    $("action-detail").className =
      `action-detail ${a?.kind || ""} ${preview ? "predicted" : ""}`;
    $("action-detail").innerHTML = a
      ? `<strong>${esc(a.title)}</strong><p>${esc(a.detail)}</p><div>${a.accesses.map((x, i) => `<button data-object="${i}">${esc(object(x))} ↗</button>`).join("")}</div>`
      : `<p>${esc(
          this.actions
            .filter((x) => x.kind === "write" || x.kind === "effect")
            .map((x) => x.detail)
            .join("；") || "选择一个动作查看；播放和回看不会重新执行指令。",
        )}</p>`;
    $("action-detail")
      .querySelectorAll("[data-object]")
      .forEach(
        (b) =>
          (b.onclick = () =>
            this.onObject(a.accesses[Number(b.dataset.object)])),
      );
    $("action-prev").disabled = this.index <= 0;
    $("action-next").disabled =
      !this.actions.length || this.index >= this.actions.length - 1;
    $("action-play").disabled = !this.actions.length;
    const detail = $("action-detail");
    detail.getAnimations().forEach((x) => x.cancel());
    if (!this.motion.matches)
      detail.animate([{ opacity: 0.45 }, { opacity: 1 }], { duration: 180 });
    document
      .querySelectorAll(".atom-read,.atom-write")
      .forEach((el) => el.classList.remove("atom-read", "atom-write"));
    for (const access of a?.accesses || []) {
      const nodes =
        access.kind === "register"
          ? [...document.querySelectorAll("[data-register]")].filter(
              (el) => el.dataset.register === access.name,
            )
          : [...document.querySelectorAll("[data-byte]")].filter(
              (el) =>
                Number(el.dataset.byte) >= access.address &&
                Number(el.dataset.byte) < access.address + access.width,
            );
      nodes.forEach((el) =>
        el.classList.add(access.write ? "atom-write" : "atom-read"),
      );
    }
    this.onChange();
  }
}
