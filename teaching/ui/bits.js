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
const LOGIC = {
  and: ["and", "两位都是 1 才得 1"],
  andi: ["and", "两位都是 1 才得 1"],
  or: ["or", "有一位是 1 就得 1"],
  ori: ["or", "有一位是 1 就得 1"],
  xor: ["xor", "两位不同得 1，相同得 0"],
  xori: ["xor", "两位不同得 1，相同得 0"],
  nor: ["nor", "两位都是 0 才得 1（或的结果再取反）"],
};
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
  const failed = event.error ? "这一步触发了异常，目标寄存器没有被写入。" : "";

  if (SHIFTS[op]) {
    const kind = SHIFTS[op],
      src = read(rtN) | 0,
      amount = op.endsWith("v") ? read(rsN) & 31 : sa;
    const fill = kind === "left" ? "右端补 0" : kind === "logical" ? "左端补 0（逻辑右移）" : "左端补符号位（算术右移，保持正负）";
    step(`${name(rtN)} 的 32 位，要${kind === "left" ? "左" : "右"}移 ${amount} 位${op.endsWith("v") ? `（移位数取 ${name(rsN)} 的低 5 位）` : ""}；${fill}。`, [row(name(rtN), bitsOf(src))]);
    let v = src;
    for (let k = 1; k <= amount; k++) {
      const out = kind === "left" ? (v >>> 31) & 1 : v & 1;
      v = kind === "left" ? v << 1 : kind === "logical" ? v >>> 1 : v >> 1;
      const at = kind === "left" ? 31 : 0;
      step(`第 ${k} 次移动：移出 ${out}，${kind === "left" ? "右端" : "左端"}补入 ${kind === "left" ? 0 : (v >>> 31) & 1}。`, [
        row(`移 ${k} 位`, bitsOf(v), { [at]: "in" }, { out: { side: kind === "left" ? "left" : "right", bit: out } }),
      ]);
    }
    if (!amount) step("移动 0 位：结果与原值相同。", [row("结果", bitsOf(v))]);
    step(`结果 ${hexOf(v)} 写入 ${result?.name ?? "目标寄存器"}${result && (result.value | 0) !== (v | 0) ? "（与记录不一致）" : ""}。`, [row(result?.name ?? "结果", bitsOf(v), {}, { result: true })]);
    return { title: `${op}：逐位移位`, steps };
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
    const bLabel = op.startsWith("addi") ? "立即数" : name(rtN);
    const intro = sub
      ? `减法 ${name(rsN)} − ${bLabel}：机器把 ${bLabel} 的每一位取反再加 1（补码），变成加法。`
      : `加法 ${name(rsN)} + ${bLabel}${op.startsWith("addi") ? "（16 位立即数先符号扩展成 32 位）" : ""}：从最低位开始逐位相加，满 2 向高位进 1。`;
    const carryRow = (upto) =>
      row("进位", Array.from({ length: 32 }, (_, j) => (31 - j < upto ? carries[31 - j] : null)), {}, { carry: true });
    const pending = (upto) => S.map((s, j) => (31 - j < upto ? s : null));
    step(intro, [row(name(rsN), A), row(sub ? `${bLabel} 取反` : bLabel, B), carryRow(sub ? 1 : 0), row("结果", pending(0))]);
    for (let k = 4; k <= 32; k += 4) {
      const marks = {};
      for (let j = 32 - k; j < 36 - k; j++) marks[j] = "new";
      step(`第 ${k - 3}–${k} 位：每一位 = 两个加数的位 + 进位，结果写下个位，进位带到更高一位。`, [
        row(name(rsN), A),
        row(sub ? `${bLabel} 取反` : bLabel, B),
        carryRow(k),
        row("结果", pending(k), marks),
      ]);
    }
    const trapping = op === "add" || op === "addi" || op === "sub";
    const note = overflow
      ? trapping
        ? `最高位的进位进出不一致：有符号溢出。${op} 检查溢出，会触发异常。`
        : `最高位的进位进出不一致：按有符号数看溢出了，但 ${op} 不检查溢出，照常写入。`
      : carries[32]
        ? "最高位向外的进位被丢弃（32 位放不下），按有符号数看没有溢出。"
        : "没有溢出。";
    step(`${note}${failed}${result ? ` 结果 ${hexOf(S.reduce((v, s) => (v << 1) | s, 0))} 写入 ${result.name}。` : ""}`, [
      row("结果", S, {}, { result: true }),
    ]);
    return { title: `${op}：逐位${sub ? "相减" : "相加"}`, steps, overflow };
  }

  if (LOGIC[op]) {
    const [kind, rule] = LOGIC[op],
      a = read(rsN) | 0,
      bv = op.endsWith("i") ? uimm : read(rtN) | 0;
    const A = bitsOf(a),
      B = bitsOf(bv),
      f = { and: (x, y) => x & y, or: (x, y) => x | y, xor: (x, y) => x ^ y, nor: (x, y) => 1 - (x | y) }[kind],
      S = A.map((x, j) => f(x, B[j]));
    const bLabel = op.endsWith("i") ? "立即数（零扩展）" : name(rtN);
    step(`${op}：逐位比较，${rule}。各位互不影响，没有进位。`, [row(name(rsN), A), row(bLabel, B), row("结果", S.map(() => null))]);
    for (let k = 8; k <= 32; k += 8) {
      const marks = {};
      for (let j = 32 - k; j < 40 - k; j++) marks[j] = "new";
      step(`第 ${k - 7}–${k} 位。`, [row(name(rsN), A), row(bLabel, B), row("结果", S.map((s, j) => (31 - j < k ? s : null)), marks)]);
    }
    step(`结果写入 ${result?.name ?? "目标寄存器"}。`, [row("结果", S, {}, { result: true })]);
    return { title: `${op}：逐位${kind}`, steps };
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
    step(`${signed ? "有符号" : "无符号"}相乘：两个 32 位数的乘积最多要 64 位。`, [row(name(rsN), bitsOf(a)), row(name(rtN), bitsOf(c))]);
    step("乘积的高 32 位放进 HI，低 32 位放进 LO；用 mfhi / mflo 取出。", [
      row("乘积", bits, Object.fromEntries(bits.map((_, j) => [j, j < 32 ? "hi" : "lo"])), { wide: true }),
      row("HI", bits.slice(0, 32)),
      row("LO", bits.slice(32)),
    ]);
    return { title: `${op}：64 位乘积`, steps };
  }
  if (!c) {
    step("除数为 0：MIPS 不产生异常，HI 和 LO 的值没有规定，不能使用。", [row(name(rsN), bitsOf(a)), row(name(rtN), bitsOf(c))]);
    return { title: `${op}：除以 0`, steps };
  }
  const q = big(a) / big(c),
    r = big(a) - q * big(c);
  step(`${signed ? "有符号" : "无符号"}相除：${name(rsN)} ÷ ${name(rtN)}。`, [row(name(rsN), bitsOf(a)), row(name(rtN), bitsOf(c))]);
  step("商放进 LO，余数放进 HI；用 mflo / mfhi 取出。", [row("LO（商）", bitsOf(q)), row("HI（余数）", bitsOf(r))]);
  return { title: `${op}：商和余数`, steps };
}
