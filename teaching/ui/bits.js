import { t, localized } from "./i18n/index.js";
// Bit-level view of one executed machine instruction (classroom 2026-10-24):
// shifts bit by bit, addition and subtraction with carries, bitwise logic,
// and the 64-bit product or quotient/remainder of mult/div. Everything comes
// from the recorded event's reads and writes; nothing is executed here.
// A story is a list of steps; each step is a caption plus rows of 32 (or 64)
// bits, most significant first, with per-bit marks for the renderer.

const bitsOf = (v, n = 32) =>
  Array.from({ length: n }, (_, i) => Number((BigInt.asUintN(n, BigInt(v)) >> BigInt(n - 1 - i)) & 1n));
const row = (label, bits, marks = {}, extra = {}) => ({ label, bits, marks, ...extra });
const hexOf = (v) => "0x" + (v >>> 0).toString(16).padStart(8, "0");

const SHIFTS = { sll: "left", sllv: "left", srl: "logical", srlv: "logical", sra: "arith", srav: "arith" };
const ADDS = { add: "add", addu: "add", addi: "add", addiu: "add", sub: "sub", subu: "sub" };
const LOGIC = localized(() => ({
  and: ["and", t("bits.rule.and")],
  andi: ["and", t("bits.rule.and")],
  or: ["or", t("bits.rule.or")],
  ori: ["or", t("bits.rule.or")],
  xor: ["xor", t("bits.rule.xor")],
  xori: ["xor", t("bits.rule.xor")],
  nor: ["nor", t("bits.rule.nor")],
}));
const MULDIV = { mult: true, multu: false, div: true, divu: false };

export function supportsBits(event) {
  const op = event?.instruction?.op;
  return !!(op && (SHIFTS[op] || ADDS[op] || LOGIC[op] || op in MULDIV));
}

export function bitStory(event, name = (n) => "$" + n) {
  const ins = event?.instruction;
  if (!supportsBits(event)) return null;
  const op = ins.op,
    b = ins.binary | 0,
    rsN = (b >>> 21) & 31,
    rtN = (b >>> 16) & 31,
    sa = (b >>> 6) & 31,
    imm = (b << 16) >> 16,
    uimm = b & 0xffff;
  const accesses = event.accesses || [];
  const read = (n) =>
    n === 0 ? 0 : (accesses.find((a) => a.kind === "register" && !a.write && a.number === n)?.value ?? 0);
  const written = accesses.filter((a) => a.kind === "register" && a.write);
  const result = written[0];
  const steps = [];
  const step = (caption, rows) => steps.push({ caption, rows });
  const failed = event.error ? t("bits.exception") : "";

  if (SHIFTS[op]) {
    const kind = SHIFTS[op],
      src = read(rtN) | 0,
      amount = op.endsWith("v") ? read(rsN) & 31 : sa;
    const fill = kind === "left" ? t("bits.shift.fillRight") : kind === "logical" ? t("bits.shift.fillLeftZero") : t("bits.shift.fillLeftSign");
    step(t("bits.shift.intro", { reg: name(rtN), direction: kind === "left" ? t("bits.shift.left") : t("bits.shift.right"), amount, note: op.endsWith("v") ? t("bits.shift.variable", { reg: name(rsN) }) : "", fill }), [row(name(rtN), bitsOf(src))]);
    let v = src;
    for (let k = 1; k <= amount; k++) {
      const out = kind === "left" ? (v >>> 31) & 1 : v & 1;
      v = kind === "left" ? v << 1 : kind === "logical" ? v >>> 1 : v >> 1;
      const at = kind === "left" ? 31 : 0;
      step(t("bits.shift.step", { k, out, side: kind === "left" ? t("bits.shift.rightEnd") : t("bits.shift.leftEnd"), bit: kind === "left" ? 0 : (v >>> 31) & 1 }), [
        row(t("bits.shift.after", { k }), bitsOf(v), { [at]: "in" }, { out: { side: kind === "left" ? "left" : "right", bit: out } }),
      ]);
    }
    if (!amount) step(t("bits.shift.none"), [row(t("bits.result"), bitsOf(v))]);
    step(t("bits.shift.result", { value: hexOf(v), reg: result?.name ?? t("bits.target"), mismatch: result && (result.value | 0) !== (v | 0) ? t("bits.mismatch") : "" }), [row(result?.name ?? t("bits.result"), bitsOf(v), {}, { result: true })]);
    return { title: t("bits.shift.title", { op }), steps };
  }

  if (ADDS[op]) {
    const sub = ADDS[op] === "sub",
      a = read(rsN) | 0,
      bv = op.startsWith("addi") ? imm : read(rtN) | 0,
      operand = sub ? ~bv : bv;
    const A = bitsOf(a),
      B = bitsOf(operand),
      carries = new Array(33).fill(0),
      S = new Array(32).fill(0);
    carries[0] = sub ? 1 : 0;
    for (let i = 0; i < 32; i++) {
      const ai = A[31 - i], bi = B[31 - i], c = carries[i];
      S[31 - i] = ai ^ bi ^ c;
      carries[i + 1] = (ai & bi) | (ai & c) | (bi & c);
    }
    const overflow = carries[31] !== carries[32];
    const bLabel = op.startsWith("addi") ? t("bits.immediate") : name(rtN);
    const intro = sub
      ? t("bits.sub.intro", { a: name(rsN), b: bLabel, b: bLabel })
      : t("bits.add.intro", { a: name(rsN), b: bLabel, note: op.startsWith("addi") ? t("bits.add.signExtend") : "" });
    const carryRow = (upto) =>
      row(t("bits.carry"), Array.from({ length: 32 }, (_, j) => (31 - j < upto ? carries[31 - j] : null)), {}, { carry: true });
    const pending = (upto) => S.map((s, j) => (31 - j < upto ? s : null));
    step(intro, [row(name(rsN), A), row(sub ? t("bits.inverted", { b: bLabel }) : bLabel, B), carryRow(sub ? 1 : 0), row(t("bits.result"), pending(0))]);
    for (let k = 4; k <= 32; k += 4) {
      const marks = {};
      for (let j = 32 - k; j < 36 - k; j++) marks[j] = "new";
      step(t("bits.add.group", { from: k - 3, to: k }), [
        row(name(rsN), A),
        row(sub ? t("bits.inverted", { b: bLabel }) : bLabel, B),
        carryRow(k),
        row(t("bits.result"), pending(k), marks),
      ]);
    }
    const trapping = op === "add" || op === "addi" || op === "sub";
    const note = overflow
      ? trapping
        ? t("bits.overflow.trap", { op })
        : t("bits.overflow.ignored", { op })
      : carries[32]
        ? t("bits.overflow.carryOut")
        : t("bits.overflow.none");
    step(`${note}${failed}${result ? ` ${t("bits.add.result", { value: hexOf(S.reduce((v, s) => (v << 1) | s, 0)), reg: result.name })}` : ""}`, [
      row(t("bits.result"), S, {}, { result: true }),
    ]);
    return { title: t("bits.add.title", { op, operation: sub ? t("bits.subtract") : t("bits.addition") }), steps, overflow };
  }

  if (LOGIC[op]) {
    const [kind, rule] = LOGIC[op],
      a = read(rsN) | 0,
      bv = op.endsWith("i") ? uimm : read(rtN) | 0;
    const A = bitsOf(a),
      B = bitsOf(bv),
      f = { and: (x, y) => x & y, or: (x, y) => x | y, xor: (x, y) => x ^ y, nor: (x, y) => 1 - (x | y) }[kind],
      S = A.map((x, j) => f(x, B[j]));
    const bLabel = op.endsWith("i") ? t("bits.immediateZero") : name(rtN);
    step(t("bits.logic.intro", { op, rule }), [row(name(rsN), A), row(bLabel, B), row(t("bits.result"), S.map(() => null))]);
    for (let k = 8; k <= 32; k += 8) {
      const marks = {};
      for (let j = 32 - k; j < 40 - k; j++) marks[j] = "new";
      step(t("bits.logic.group", { from: k - 7, to: k }), [row(name(rsN), A), row(bLabel, B), row(t("bits.result"), S.map((s, j) => (31 - j < k ? s : null)), marks)]);
    }
    step(t("bits.logic.result", { reg: result?.name ?? t("bits.target") }), [row(t("bits.result"), S, {}, { result: true })]);
    return { title: t("bits.logic.title", { op, kind }), steps };
  }

  // mult / div: the 64-bit product split into HI and LO, or quotient (LO)
  // and remainder (HI). Static: two steps.
  const signed = MULDIV[op],
    a = read(rsN),
    c = read(rtN);
  const big = (v) => (signed ? BigInt(v | 0) : BigInt(v >>> 0));
  if (op.startsWith("mult")) {
    const product = BigInt.asUintN(64, big(a) * big(c));
    const bits = bitsOf(product, 64);
    step(t("bits.mul.intro", { kind: signed ? t("bits.signed") : t("bits.unsigned") }), [row(name(rsN), bitsOf(a)), row(name(rtN), bitsOf(c))]);
    step(t("bits.mul.hilo"), [
      row(t("bits.product"), bits, Object.fromEntries(bits.map((_, j) => [j, j < 32 ? "hi" : "lo"])), { wide: true }),
      row("HI", bits.slice(0, 32)),
      row("LO", bits.slice(32)),
    ]);
    return { title: t("bits.mul.title", { op }), steps };
  }
  if (!c) {
    step(t("bits.div.zero"), [row(name(rsN), bitsOf(a)), row(name(rtN), bitsOf(c))]);
    return { title: t("bits.div.zeroTitle", { op }), steps };
  }
  const q = big(a) / big(c),
    r = big(a) - q * big(c);
  step(t("bits.div.intro", { kind: signed ? t("bits.signed") : t("bits.unsigned"), a: name(rsN), b: name(rtN) }), [row(name(rsN), bitsOf(a)), row(name(rtN), bitsOf(c))]);
  step(t("bits.div.hilo"), [row(t("bits.div.lo"), bitsOf(q)), row(t("bits.div.hi"), bitsOf(r))]);
  return { title: t("bits.div.title", { op }), steps };
}
