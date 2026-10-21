import { hex, escapeHTML } from "./model.js";
export class OverlayRenderer {
  constructor({
    getState,
    getEditor,
    getFile,
    getView,
    getFocus,
    onAddress,
    onSource,
  }) {
    Object.assign(this, {
      getState,
      getEditor,
      getFile,
      getView,
      getFocus,
      onAddress,
      onSource,
    });
    this.svg = document.querySelector("#overlay");
    window.addEventListener("resize", () => this.schedule());
    document.addEventListener("scroll", () => this.schedule(), true);
    new ResizeObserver(() => this.schedule()).observe(
      document.querySelector(".workspace"),
    );
  }
  schedule() {
    cancelAnimationFrame(this.frame);
    this.frame = requestAnimationFrame(() => this.draw());
  }
  center(el) {
    if (!el) return null;
    let r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return null;
    let parent = el.closest(
      "#registers,#memory,.inspector,.cm-scroller,#machine,#cfg",
    );
    if (parent) {
      let p = parent.getBoundingClientRect();
      if (r.bottom < p.top || r.top > p.bottom) return null;
    }
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }
  codePoint(ins, name) {
    if (!ins) return null;
    if (this.getView() === "machine")
      return this.center(
        document.querySelector(`[data-instruction="${ins.address}"]`),
      );
    if (this.getView() !== "source" || ins.file !== this.getFile()) return null;
    let editor = this.getEditor();
    if (ins.line > editor.state.doc.lines || ins.line < 1) return null;
    let line = editor.state.doc.line(ins.line),
      index = name ? line.text.indexOf(name) : -1;
    let pos = line.from + (index < 0 ? line.text.search(/\S/) : index);
    let c = editor.coordsAtPos(Math.max(line.from, pos));
    if (!c) return null;
    let bounds = editor.scrollDOM.getBoundingClientRect();
    if (c.top < bounds.top || c.bottom > bounds.bottom) return null;
    return {
      x: c.left + (name ? Math.max(8, name.length * 3) : 15),
      y: (c.top + c.bottom) / 2,
    };
  }
  draw() {
    let s = this.getState();
    if (!s) {
      this.svg.innerHTML = "";
      return;
    }
    let paths = [],
      labels = [],
      focus = this.getFocus();
    let colors = {
      read: getComputedStyle(document.body).getPropertyValue("--blue").trim(),
      write: getComputedStyle(document.body)
        .getPropertyValue("--orange")
        .trim(),
      flow: getComputedStyle(document.body).getPropertyValue("--purple").trim(),
    };
    let draw = (a, b, type, dashed, label, action) => {
      if (!a || !b) return;
      let n = paths.length,
        curve = Math.min(100, Math.abs(b.x - a.x) * 0.35 + 25),
        d = `M ${a.x} ${a.y} C ${a.x + curve} ${a.y}, ${b.x - curve} ${b.y}, ${b.x} ${b.y}`;
      paths.push(
        `<path d="${d}" fill="none" stroke="${colors[type]}" stroke-width="1.6" opacity="${focus ? 0.58 : 0.32}" ${dashed ? 'stroke-dasharray="5 5"' : ""} marker-end="url(#arrow-${type})"/>`,
      );
      if (label) {
        let x = (a.x + b.x) / 2,
          y = (a.y + b.y) / 2 + ((n % 3) - 1) * 12;
        labels.push(
          `<g class="edge-label" data-action="${action || ""}" style="pointer-events:auto;cursor:pointer"><rect x="${x - 3}" y="${y - 10}" width="${Math.min(220, label.length * 5.8 + 8)}" height="15" rx="3" fill="var(--panel)" opacity=".9"/><text x="${x}" y="${y}" fill="${colors[type]}" font-size="9" font-family="monospace">${escapeHTML(label)}</text></g>`,
        );
      }
    };
    for (let [event, dashed, key] of [
      [s.last, false, "solid"],
      [s.preview, true, "dashed"],
    ]) {
      if (!event || !document.querySelector("#" + key).checked) continue;
      let origin =
          this.codePoint(event.instruction) ||
          this.center(
            document.querySelector(dashed ? "#next-card" : "#last-card"),
          ),
        seen = new Set();
      for (let a of event.accesses || []) {
        let type = a.write ? "write" : "read";
        if (
          !document.querySelector(type === "write" ? "#writes" : "#reads")
            .checked
        )
          continue;
        let name = a.kind === "register" ? a.name : "mem:" + a.address;
        let k = type + name;
        if (seen.has(k)) continue;
        seen.add(k);
        if (focus && focus !== name) continue;
        let target = this.center(
          a.kind === "register"
            ? document.querySelector(`[data-register="${a.name}"]`)
            : document.querySelector(`[data-byte="${a.address}"]`),
        );
        let offscreen = false;
        if (!target) {
          target = this.center(
            document.querySelector(
              a.kind === "register" ? "#reg-filter" : "#address",
            ),
          );
          offscreen = true;
        }
        let code = this.codePoint(event.instruction, a.name) || origin;
        let label = offscreen
          ? a.kind === "memory"
            ? hex(a.address)
            : a.name
          : focus
            ? a.write
              ? `${a.before} → ${a.value}`
              : `${a.value}`
            : "";
        draw(
          a.write ? code : target,
          a.write ? target : code,
          type,
          dashed,
          label,
          a.kind === "memory" ? "memory:" + a.address : "register:" + a.name,
        );
        if (paths.length >= 35) break;
      }
      if (
        document.querySelector("#flows").checked &&
        event.nextPC != null &&
        !focus
      ) {
        let targetIns = s.instructions?.find((i) => i.address === event.nextPC),
          target = this.codePoint(targetIns);
        if (!target) target = this.center(document.querySelector("#location"));
        draw(
          origin,
          target,
          "flow",
          dashed,
          event.nextPC !== event.pc + 4 ? `→ ${hex(event.nextPC)}` : "",
          "source:" + event.nextPC,
        );
      }
    }
    this.svg.innerHTML = `<defs>${Object.entries(colors)
      .map(
        ([type, c]) =>
          `<marker id="arrow-${type}" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6" fill="${c}"/></marker>`,
      )
      .join("")}</defs>${paths.join("")}${labels.join("")}`;
    this.svg.querySelectorAll("[data-action]").forEach(
      (e) =>
        (e.onclick = () => {
          let [type, ...rest] = e.dataset.action.split(":");
          if (type === "memory") this.onAddress(Number(rest.join(":")));
          if (type === "source") this.onSource(Number(rest.join(":")));
        }),
    );
  }
}
