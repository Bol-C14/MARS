import { buildCFG } from "./model.js";
// Lays out the focus-mode window (DESIGN §3.7): the step just completed plus
// the backend lookahead, as visited CFG blocks ("segments") joined by edges.
// Pure: derives everything from recorded events and the static program.

const edgeLabels = {
  next: "顺序",
  fallthrough: "条件不成立",
  taken: "条件成立",
  jump: "跳转",
  call: "调用",
  return: "返回",
};

// Branches whose condition cannot fail (e.g. `b label` assembles to bgez $zero).
function unconditional(ins) {
  const rs = (ins.binary >>> 21) & 31,
    rt = (ins.binary >>> 16) & 31;
  if (ins.op === "beq") return rs === rt;
  return rs === 0 && /^(bgez|blez|bgezal)$/.test(ins.op);
}

function transferKind(event, target, delay) {
  const ins = event.instruction;
  if (ins.flow === "branch") {
    if (unconditional(ins)) return "jump";
    if (target === ins.target) return "taken";
    if (target === ins.address + (delay ? 8 : 4)) return "fallthrough";
    return "jump";
  }
  if (ins.flow === "call") return "call";
  if (ins.flow === "indirect")
    return ins.op === "jr" && ((ins.binary >>> 21) & 31) === 31
      ? "return"
      : "jump";
  return "jump";
}

// The control transfer that ended `step`, if any. With delayed branching it
// sits one instruction before the delay slot, possibly on the previous line.
function lastTransfer(step, before, delay) {
  if (!step) return null;
  const recent = [...step.events].reverse();
  if (before) recent.push(...[...before.events].reverse());
  // A delayed transfer takes effect only after its delay slot has run.
  const e = recent[delay ? 1 : 0];
  return e && e.instruction.flow !== "next" ? e : null;
}

export function layoutPath({
  last = null,
  history = [],
  lookahead = null,
  instructions = [],
  symbols = [],
  delay = false,
  mode = "auto",
  lines = 8,
} = {}) {
  const blocks = buildCFG(instructions, delay),
    owner = new Map(),
    lineStart = new Map(),
    names = new Map();
  for (const b of blocks)
    for (const i of b.instructions) owner.set(i.address, b.id);
  for (const i of instructions) {
    const key = i.file + ":" + i.line;
    if (!lineStart.has(key) || i.address < lineStart.get(key))
      lineStart.set(key, i.address);
  }
  for (const s of symbols)
    if (!s.data && !names.has(s.address)) names.set(s.address, s.name);
  const where = (address) => {
    const i = instructions.find((x) => x.address === address);
    return i ? { address, file: i.file, line: i.line } : { address };
  };
  const labelOf = (address) => {
    if (names.has(address)) return names.get(address);
    const w = where(address);
    return w.line ? `第 ${w.line} 行` : "";
  };

  const steps = [];
  const addStep = (index, predicted, file, line, events) =>
    steps.push({
      index,
      predicted,
      file,
      line,
      address:
        lineStart.get(file + ":" + line) ?? events[0].instruction.address,
      events,
      block: owner.get(events[0].instruction.address) ?? null,
    });
  // The completed step is the whole source line that just ran: a
  // pseudo-instruction's earlier machine instructions come from history,
  // grouped like source stepping (same line, sequential PCs).
  if (last?.instruction) {
    const done = [last];
    const byStep = new Map(history.map((e) => [e.step, e]));
    for (let e = byStep.get(last.step - 1); e; e = byStep.get(e.step - 1)) {
      const next = done[0];
      if (
        e.instruction.file !== next.instruction.file ||
        e.instruction.line !== next.instruction.line ||
        e.pc + 4 !== next.pc
      )
        break;
      done.unshift(e);
    }
    addStep(-1, false, last.instruction.file, last.instruction.line, done);
  }

  // Window range: fixed N lines, or (auto) the rest of the current block plus
  // the path it leads into, up to that path's own control decision.
  const groups = lookahead?.groups || [];
  const cap = mode === "auto" ? 8 : Math.max(1, Math.min(8, lines));
  let decisions = 0,
    truncated = false;
  for (let k = 0; k < groups.length; k++) {
    const g = groups[k];
    if (k >= cap) {
      truncated = true;
      break;
    }
    if (k > 0 && lastTransfer(steps.at(-1), steps.at(-2), delay)) decisions++;
    if (mode === "auto" && decisions >= 2) {
      truncated = true;
      break;
    }
    addStep(k, true, g.file, g.line, g.events);
  }

  // Segments are visited blocks; re-entering one counts a new iteration.
  const segments = new Map(),
    edges = new Map(),
    hints = new Map();
  let prior = null;
  for (const step of steps) {
    const id = step.block ?? step.address;
    if (!segments.has(id))
      segments.set(id, {
        id,
        // A symbol names the block only when it starts there; otherwise the view shows line numbers.
        label: names.get(id) ?? null,
        file: step.file,
        lines: new Map(),
        iterations: 0,
      });
    const seg = segments.get(id);
    const entering =
      !prior || prior.segment !== id || step.address <= prior.address;
    if (entering) seg.iterations++;
    step.segment = id;
    step.iteration = seg.iterations;
    if (!seg.lines.has(step.address))
      seg.lines.set(step.address, {
        file: step.file,
        line: step.line,
        address: step.address,
        steps: [],
      });
    seg.lines.get(step.address).steps.push(step.index);

    if (prior && entering) {
      const transfer = lastTransfer(prior, prior.prev, delay);
      const first = step.events[0].instruction.address;
      // A gap with no transfer in view means it happened just before the
      // window (a delay slot as the completed step); the kind is then unknown.
      const sequential = first === prior.events.at(-1).instruction.address + 4;
      const kind = transfer
        ? transferKind(transfer, first, delay)
        : sequential
          ? "next"
          : "jump";
      const key = `${prior.segment}>${id}>${kind}`;
      if (!edges.has(key))
        edges.set(key, {
          from: prior.segment,
          to: id,
          kind,
          label: edgeLabels[kind],
          step: prior.index,
          count: 0,
        });
      edges.get(key).count++;
      if (
        transfer?.instruction.flow === "branch" &&
        !unconditional(transfer.instruction) &&
        (kind === "taken" || kind === "fallthrough")
      ) {
        const ins = transfer.instruction,
          alt = kind === "taken" ? ins.address + (delay ? 8 : 4) : ins.target,
          hintKey = ins.address + ">" + alt;
        if (!hints.has(hintKey))
          hints.set(hintKey, {
            step: prior.index,
            segment: prior.segment,
            branch: ins.address,
            line: ins.line,
            target: where(alt),
            kind: kind === "taken" ? "fallthrough" : "taken",
            label: labelOf(alt),
          });
      }
    }
    step.prev = prior;
    prior = step;
  }
  for (const s of steps) delete s.prev;

  return {
    steps,
    segments: [...segments.values()].map((s) => ({
      ...s,
      lines: [...s.lines.values()].sort((a, b) => a.address - b.address),
    })),
    edges: [...edges.values()],
    hints: [...hints.values()],
    stop: {
      reason: truncated ? "window" : lookahead?.stop || "",
      at: truncated
        ? where(groups[steps.filter((s) => s.predicted).length]?.address)
        : lookahead?.stopAt || null,
      complete: truncated ? true : (lookahead?.complete ?? true),
      truncated,
    },
  };
}
