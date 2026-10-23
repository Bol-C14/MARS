import { hex, registerNames, services } from "./model.js";
import { escapeByte } from "./radix.js";
// Fill-in-the-blank explanation of one recorded step (DESIGN §3.7): a symbolic
// template, then beats that each substitute one recorded value. Values come
// only from the event's accesses; nothing here executes or predicts.

// A number in an equation keeps its raw value, width and kind next to the
// default text, so read-only views can show it in the chosen radix (C2).
const N = (v, w = 4, k = "value") => ({
  num: true,
  t: k === "value" ? show(v) : w < 4 ? byteHex(v, w) : hex(v),
  v,
  w,
  k,
});
const styled = (c) => (t) =>
  t && typeof t === "object" && t.num ? { ...t, c } : { t: String(t), c };
const dim = styled("dim");
const fresh = styled("fresh");
const ok = styled("ok");
const text = (parts) =>
  parts.map((p) => (typeof p === "string" ? p : p.t)).join("");
const id = (a) =>
  a.kind === "register" ? "reg:" + a.name : "mem:" + a.address;
const masked = (n, width) => (width < 4 ? n & (2 ** (8 * width) - 1) : n);
const byteHex = (n, width) =>
  "0x" + (masked(n, width) >>> 0).toString(16).padStart(2 * width, "0");
// Small integers read naturally in decimal; addresses and bit patterns in hex.
const show = (n, asHex) => (asHex || Math.abs(n) >= 10000 ? hex(n) : String(n));
const littleEndian = (address, n, width) =>
  Array.from(
    { length: width },
    (_, i) => `[${hex(address + i)}] ${byteHex(n >>> (8 * i), 1)}`,
  ).join(" ");

const binaryOps = {
  add: ["+", "有符号相加；结果超出 32 位范围时触发溢出异常（addu 不检查）。"],
  addu: ["+", "相加，不检查溢出；超出 32 位的部分被丢弃。"],
  sub: ["−", "有符号相减；溢出时触发异常（subu 不检查）。"],
  subu: ["−", "相减，不检查溢出。"],
  and: ["&", "逐位与：两位都是 1 才得 1。", true],
  or: ["|", "逐位或：任一位是 1 就得 1。", true],
  xor: ["^", "逐位异或：两位不同得 1。", true],
  nor: ["nor", "逐位或之后取反：~(a | b)。", true],
  slt: ["<", "按有符号数比较，成立得 1，否则得 0。"],
  sltu: ["<ᵤ", "按无符号数比较，成立得 1，否则得 0。"],
  mul: ["×", "相乘，只保留乘积的低 32 位。"],
};
const immediateOps = {
  addi: ["+", "立即数做符号扩展后相加；溢出时触发异常。"],
  addiu: ["+", "立即数做符号扩展后相加，不检查溢出。"],
  slti: ["<", "立即数符号扩展后按有符号比较，成立得 1。"],
  sltiu: ["<ᵤ", "立即数先符号扩展，再按无符号比较，成立得 1。"],
  andi: ["&", "立即数做零扩展（高 16 位补 0）后逐位与。", true],
  ori: ["|", "立即数做零扩展（高 16 位补 0）后逐位或。", true],
  xori: ["^", "立即数做零扩展（高 16 位补 0）后逐位异或。", true],
};
const shiftOps = {
  sll: ["<<", "左移，右侧补 0。"],
  srl: [">>>", "逻辑右移，左侧补 0。"],
  sra: [">>", "算术右移，左侧补符号位。"],
  sllv: ["<<", "左移，移位量取寄存器的低 5 位。"],
  srlv: [">>>", "逻辑右移，移位量取寄存器的低 5 位。"],
  srav: [">>", "算术右移，移位量取寄存器的低 5 位。"],
};
const compareZero = {
  blez: ["≤ 0", (v) => v <= 0],
  bgtz: ["> 0", (v) => v > 0],
  bltz: ["< 0", (v) => v < 0],
  bgez: ["≥ 0", (v) => v >= 0],
  bltzal: ["< 0", (v) => v < 0],
  bgezal: ["≥ 0", (v) => v >= 0],
};
const loads = {
  lw: [4, "内存", false],
  ll: [4, "内存", false],
  lh: [2, "半字", true],
  lhu: [2, "半字", false],
  lb: [1, "字节", true],
  lbu: [1, "字节", false],
};
const stores = {
  sw: [4, "内存"],
  sc: [4, "内存"],
  sh: [2, "半字"],
  sb: [1, "字节"],
};

export function beatModel(
  event,
  { delay = false, instructions = [], symbols = [] } = {},
) {
  if (!event?.instruction)
    return { template: [], beats: [], summary: "", objects: [] };
  const ins = event.instruction,
    op = ins.op,
    bits = ins.binary | 0,
    accesses = event.accesses || [];
  const rsN = (bits >>> 21) & 31,
    rtN = (bits >>> 16) & 31,
    rdN = (bits >>> 11) & 31,
    sa = (bits >>> 6) & 31,
    imm = (bits << 16) >> 16,
    uimm = bits & 0xffff;
  const name = (n) => "$" + registerNames[n];
  const reads = accesses.filter((a) => a.kind === "register" && !a.write);
  const writes = accesses.filter((a) => a.kind === "register" && a.write);
  const mem = accesses.find((a) => a.kind === "memory");
  const read = (n) => reads.find((a) => a.number === n);
  const readNamed = (n) => reads.find((a) => a.name === n);
  const written = (n) => writes.find((a) => a.name === n);
  const rs = read(rsN),
    rt = read(rtN);
  const where = (address) => {
    const s = symbols.find((x) => x.address === address && !x.data);
    if (s) return s.name;
    const i = instructions.find((x) => x.address === address);
    return i ? `第 ${i.line} 行` : hex(address);
  };

  let template = [ins.source?.trim() || ins.basic || op];
  // A blocked preview never ran: it has no next PC and no accesses.
  if (
    event.nextPC == null &&
    !accesses.length &&
    event.status !== "waiting-input"
  )
    return {
      template,
      beats: [
        {
          eq: [fresh(event.status === "ended" ? "程序已结束" : "无法执行")],
          caption:
            event.status === "ended"
              ? "这条指令不会再执行。"
              : String(event.status ?? ""),
          lit: [],
          tokens: [],
          why: "",
        },
      ],
      summary: event.status === "ended" ? "程序已结束" : "无法执行",
      objects: [],
    };
  const beats = [];
  const beat = (eq, caption, { lit = [], tokens = [], why = "" } = {}) =>
    beats.push({ eq, caption, lit, tokens, why });
  const reading = (list) => ({
    lit: list.map((a) => ({ id: id(a), mode: "read" })),
    tokens: unique(list).map((a) => ({
      from: id(a),
      to: "code",
      label: show(a.value),
      kind: "read",
      value: N(a.value, a.width || 4, a.kind === "memory" ? "bits" : "value"),
    })),
  });
  const writing = (a, label = show(a.value)) => ({
    lit: [{ id: id(a), mode: "write" }],
    tokens: [
      {
        from: "code",
        to: id(a),
        label,
        kind: "write",
        value: N(
          a.kind === "memory" ? masked(a.value, a.width) : a.value,
          a.width || 4,
          /^0x/.test(label) ? "bits" : "value",
        ),
      },
    ],
  });
  // Base + offset → effective address. With a zero offset the base already is
  // the address, so one beat says both instead of repeating the same line.
  const addressing = (at, base, off, addr, width) => {
    const align =
      width > 1
        ? `${op} 要求地址是 ${width} 的倍数，否则触发地址异常。`
        : "按字节访问不需要对齐。";
    if (rs && imm !== 0) {
      beat(at([fresh(N(rs.value, 4, "bits")), off]), `取基址 ${base} 的值。`, {
        ...reading([rs]),
        why: `地址 = 基址寄存器 + 16 位有符号偏移（${imm}）。`,
      });
      beat(at([fresh(N(addr, 4, "bits"))]), "得到地址。", {
        why: `${hex(rs.value)} + (${imm}) = ${hex(addr)}。${align}`,
      });
    } else if (rs)
      beat(
        at([fresh(N(addr, 4, "bits"))]),
        `取基址 ${base} 的值，它就是地址。`,
        {
          ...reading([rs]),
          why: `偏移为 0，地址就是 ${base} 的值。${align}`,
        },
      );
    else beat(at([fresh(N(addr, 4, "bits"))]), "得到地址。", { why: align });
  };
  // Final beat for a register result, or the explicit discard to $zero.
  const writeBack = (dest, value, asHex, why) => {
    const a = written(dest);
    if (a)
      beat(
        [dest, " = ", ok(N(a.value, 4, asHex ? "bits" : "value")), " ✓"],
        `写回 ${dest}。`,
        {
          ...writing(a, show(a.value, asHex)),
          why,
        },
      );
    else if (dest === "$zero")
      beat([dest, " = ", ok("0"), " ✓"], "$zero 恒为 0，结果被丢弃。", {
        why: "写入 $zero 不产生效果。",
      });
  };

  if (binaryOps[op] && rs && rt) {
    const [sym, rule, asHex] = binaryOps[op],
      dest = name(rdN),
      res = written(dest);
    const expr = (a, b) =>
      op === "nor" ? ["~(", a, " | ", b, ")"] : [a, ` ${sym} `, b];
    template = [dest, " ← ", ...expr(dim(rs.name), dim(rt.name))];
    beat(
      [
        dest,
        " ← ",
        ...expr(
          fresh(N(rs.value, 4, asHex ? "bits" : "value")),
          fresh(N(rt.value, 4, asHex ? "bits" : "value")),
        ),
      ],
      `取 ${rs.name} 和 ${rt.name} 的值。`,
      reading([rs, rt]),
    );
    if (res)
      beat(
        [dest, " ← ", fresh(N(res.value, 4, asHex ? "bits" : "value"))],
        /^sltu?$/.test(op)
          ? `${rs.value} ${sym} ${rt.value} ${res.value ? "为真" : "为假"}，所以结果是 ${res.value}。`
          : "计算。",
        {
          why: rule,
        },
      );
    writeBack(dest, res?.value, asHex);
  } else if (immediateOps[op] && rs) {
    const [sym, rule, logical] = immediateOps[op],
      dest = name(rtN),
      res = written(dest),
      k = logical ? hex(uimm) : String(imm);
    template = [dest, " ← ", dim(rs.name), ` ${sym} ${k}`];
    beat(
      [
        dest,
        " ← ",
        fresh(N(rs.value, 4, logical ? "bits" : "value")),
        ` ${sym} ${k}`,
      ],
      `取 ${rs.name} 的值。`,
      reading([rs]),
    );
    if (res)
      beat(
        [dest, " ← ", fresh(N(res.value, 4, logical ? "bits" : "value"))],
        /^sltiu?$/.test(op)
          ? `${rs.value} ${sym} ${k} ${res.value ? "为真" : "为假"}，所以结果是 ${res.value}。`
          : "计算。",
        {
          why: rule,
        },
      );
    writeBack(dest, res?.value, logical);
  } else if (op === "lui") {
    const dest = name(rtN);
    template = [dest, " ← ", dim(hex(uimm)), " << 16"];
    const res = written(dest);
    if (res)
      beat(
        [dest, " ← ", fresh(N(res.value, 4, "bits"))],
        "立即数放到高 16 位。",
        {
          why: `${hex(uimm)} 左移 16 位，低 16 位补 0。常与 ori 组合装入 32 位常数（la / li 展开）。`,
        },
      );
    writeBack(dest, res?.value, true);
  } else if (shiftOps[op] && rt) {
    const [sym, rule] = shiftOps[op],
      dest = name(rdN),
      variable = op.endsWith("v"),
      res = written(dest);
    const amount = variable && rs ? rs.value & 31 : sa;
    template = [
      dest,
      " ← ",
      dim(rt.name),
      ` ${sym} `,
      variable ? dim(name(rsN)) : String(sa),
    ];
    beat(
      [
        dest,
        " ← ",
        fresh(N(rt.value, 4, "bits")),
        ` ${sym} `,
        variable ? fresh(N(amount)) : String(sa),
      ],
      `取 ${rt.name}${variable ? " 和移位量" : ""} 的值。`,
      reading(variable && rs ? [rt, rs] : [rt]),
    );
    if (res)
      beat([dest, " ← ", fresh(N(res.value, 4, "bits"))], "移位。", {
        why:
          rule +
          (variable && rs
            ? ` ${rs.name} = ${rs.value}，低 5 位为 ${amount}。`
            : ""),
      });
    writeBack(dest, res?.value, true);
  } else if (
    /^(mult|multu|madd|maddu|msub|msubu|div|divu)$/.test(op) &&
    rs &&
    rt
  ) {
    const H = written("hi"),
      L = written("lo"),
      division = op.startsWith("div"),
      acc = op.startsWith("madd")
        ? "HI:LO + "
        : op.startsWith("msub")
          ? "HI:LO − "
          : "";
    template = division
      ? ["LO, HI ← ", dim(rs.name), " ÷ ", dim(rt.name)]
      : ["HI:LO ← ", acc, dim(rs.name), " × ", dim(rt.name)];
    beat(
      division
        ? ["LO, HI ← ", fresh(N(rs.value)), " ÷ ", fresh(N(rt.value))]
        : ["HI:LO ← ", acc, fresh(N(rs.value)), " × ", fresh(N(rt.value))],
      `取 ${rs.name} 和 ${rt.name} 的值。`,
      reading([rs, rt]),
    );
    if (division && rt.value === 0)
      beat(["除数为 ", fresh("0")], "MIPS 不定义除以 0 的结果。", {
        why: "硬件不报错；HI、LO 的值不可依赖，程序应在除法前自行检查除数。",
      });
    else if (H && L) {
      const unsigned = op.endsWith("u");
      const big = (n) => (unsigned ? BigInt(n >>> 0) : BigInt(n | 0));
      const p64 =
        "0x" +
        (((big(H.value) << 32n) | BigInt(L.value >>> 0)) & ((1n << 64n) - 1n))
          .toString(16)
          .padStart(16, "0");
      beat(
        division
          ? ["商 ", fresh(N(L.value)), "，余数 ", fresh(N(H.value))]
          : ["HI:LO ← ", fresh(p64)],
        division ? "整数除法。" : "得到 64 位乘积。",
        {
          why: division
            ? `商放入 LO，余数放入 HI。${unsigned ? "按无符号数计算。" : "商向 0 取整，余数与被除数同号。"}`
            : `${unsigned ? "按无符号数" : "按有符号数"}相乘，结果有 64 位：高 32 位进 HI，低 32 位进 LO。`,
        },
      );
      beat(
        ["HI = ", ok(N(H.value)), "，LO = ", ok(N(L.value)), " ✓"],
        "写入 HI 和 LO。",
        {
          lit: [
            { id: id(H), mode: "write" },
            { id: id(L), mode: "write" },
          ],
          tokens: [
            { from: "code", to: id(H), label: show(H.value), kind: "write" },
            { from: "code", to: id(L), label: show(L.value), kind: "write" },
          ],
          why: division
            ? "用 mflo 取商、mfhi 取余数。"
            : "用 mflo 取低 32 位；若 HI 不是 LO 的符号扩展，说明乘积超出 32 位。",
        },
      );
    }
  } else if (/^(mfhi|mflo)$/.test(op)) {
    const src = readNamed(op === "mfhi" ? "hi" : "lo"),
      dest = name(rdN);
    template = [dest, " ← ", dim(op === "mfhi" ? "HI" : "LO")];
    if (src)
      beat(
        [dest, " ← ", fresh(N(src.value))],
        `取 ${op === "mfhi" ? "HI" : "LO"} 的值。`,
        reading([src]),
      );
    writeBack(dest);
  } else if (/^(mthi|mtlo)$/.test(op) && rs) {
    const dest = op === "mthi" ? "hi" : "lo";
    template = [dest.toUpperCase(), " ← ", dim(rs.name)];
    beat(
      [dest.toUpperCase(), " ← ", fresh(N(rs.value))],
      `取 ${rs.name} 的值。`,
      reading([rs]),
    );
    const a = written(dest);
    if (a)
      beat(
        [dest.toUpperCase(), " = ", ok(N(a.value)), " ✓"],
        `写入 ${dest.toUpperCase()}。`,
        writing(a),
      );
  } else if (/^(movn|movz)$/.test(op) && rs && rt) {
    const dest = name(rdN),
      cond = op === "movn" ? "≠" : "==",
      yes = op === "movn" ? rt.value !== 0 : rt.value === 0;
    template = ["若 ", dim(rt.name), ` ${cond} 0：`, dest, " ← ", dim(rs.name)];
    beat(
      [
        "若 ",
        fresh(N(rt.value)),
        ` ${cond} 0：`,
        dest,
        " ← ",
        fresh(N(rs.value)),
      ],
      "取条件和数据的值。",
      reading([rt, rs]),
    );
    beat(
      [fresh(yes ? "成立" : "不成立"), yes ? ` → 复制到 ${dest}` : " → 不写入"],
      "判断条件。",
    );
    if (yes) writeBack(dest);
  } else if (loads[op] && mem) {
    const [width, unit, signed] = loads[op],
      dest = name(rtN),
      base = rs?.name ?? name(rsN),
      addr = mem.address,
      raw = masked(mem.value, width);
    const off = imm === 0 ? "" : imm > 0 ? ` + ${imm}` : ` − ${-imm}`;
    template = [dest, ` ← ${unit}[ `, dim(base), `${off} ]`];
    addressing(
      (inner) => [dest, ` ← ${unit}[ `, ...inner, " ]"],
      base,
      off,
      addr,
      width,
    );
    beat(
      [
        dest,
        " ← ",
        fresh(
          N(
            width === 4 ? mem.value : raw,
            width,
            width === 4 ? "value" : "bits",
          ),
        ),
      ],
      `从内存取 ${width} 字节。`,
      {
        lit: [{ id: id(mem), mode: "read", width }],
        tokens: [
          {
            from: id(mem),
            to: "code",
            label: width === 4 ? show(mem.value) : byteHex(raw, width),
            kind: "read",
          },
        ],
        why:
          width === 1
            ? `只取这个地址上的 1 个字节 ${byteHex(raw, 1)}。`
            : `MARS 使用小端序，最低地址放最低字节：${littleEndian(addr, raw, width)} → ${byteHex(raw, width)}。`,
      },
    );
    const res = written(dest);
    if (width < 4 && res) {
      const top = raw >>> (8 * width - 1);
      beat(
        [dest, " ← ", fresh(N(res.value))],
        signed
          ? `扩成 32 位：最高位是 ${top}，${top ? "补 1" : "补 0"}。`
          : "扩成 32 位：高位补 0。",
        {
          why: signed
            ? `${op} 做符号扩展：${byteHex(raw, width)} 的最高位为 ${top}，高位全部补 ${top} → ${hex(res.value)} = ${res.value}。若用 ${op}u 则补 0，得到 ${raw}。`
            : `${op} 做零扩展：高位补 0 → ${hex(res.value)} = ${res.value}。若用 ${op.slice(0, -1)} 则按最高位补齐。`,
        },
      );
    }
    writeBack(dest);
  } else if (stores[op] && mem) {
    const [width, unit] = stores[op],
      base = rs?.name ?? name(rsN),
      src = rt,
      addr = mem.address,
      value = masked(mem.value, width);
    const off = imm === 0 ? "" : imm > 0 ? ` + ${imm}` : ` − ${-imm}`;
    template = [
      `${unit}[ `,
      dim(base),
      `${off} ] ← `,
      dim(src?.name ?? name(rtN)),
    ];
    addressing(
      (inner) => [`${unit}[ `, ...inner, " ] ← ", dim(src?.name ?? name(rtN))],
      base,
      off,
      addr,
      width,
    );
    if (src)
      beat(
        [
          `${unit}[ ${hex(addr)} ] ← `,
          fresh(
            N(
              width === 4 ? src.value : value,
              width,
              width === 4 ? "value" : "bits",
            ),
          ),
        ],
        width === 4
          ? `取 ${src.name} 的值。`
          : `取 ${src.name} 的低 ${8 * width} 位。`,
        {
          ...reading([src]),
          why:
            width === 4
              ? `${src.name} = ${show(src.value)}。`
              : `${src.name} = ${hex(src.value)}，只保留低 ${8 * width} 位 ${byteHex(value, width)}，其余位丢弃。`,
        },
      );
    beat(
      [
        `${unit}[ ${hex(addr)} ] = `,
        ok(N(value, width, width === 4 ? "value" : "bits")),
        " ✓",
      ],
      `写入 ${width} 字节。`,
      {
        lit: [{ id: id(mem), mode: "write", width }],
        tokens: [
          {
            from: "code",
            to: id(mem),
            label: width === 4 ? show(value) : byteHex(value, width),
            kind: "write",
          },
        ],
        why:
          width === 1
            ? `原值 ${byteHex(mem.before, 1)} 被覆盖。`
            : `小端序存放：${littleEndian(addr, value, width)}。`,
      },
    );
  } else if (ins.flow === "branch") {
    const target = ins.target,
      label = where(target),
      fallthrough = ins.address + (delay ? 8 : 4);
    const always =
      op === "beq" ? rsN === rtN : rsN === 0 && /^(bgez|blez|bgezal)$/.test(op);
    let taken = always;
    if (always) template = ["跳到 ", label];
    else if (/^(beq|bne)$/.test(op) && rs && rt) {
      const sym = op === "beq" ? "==" : "≠";
      taken = op === "beq" ? rs.value === rt.value : rs.value !== rt.value;
      template = [
        "若 ",
        dim(rs.name),
        ` ${sym} `,
        dim(rt.name),
        " → 跳到 ",
        label,
      ];
      beat(
        [
          "若 ",
          fresh(N(rs.value)),
          ` ${sym} `,
          fresh(N(rt.value)),
          " → 跳到 ",
          label,
        ],
        "取要比较的两个寄存器的值。",
        reading([rs, rt]),
      );
      beat(
        [
          fresh(taken ? "成立" : "不成立"),
          taken ? ` → 跳到 ${label}` : " → 继续下一条",
        ],
        `条件 ${rs.value} ${sym} ${rt.value} ${taken ? "成立" : "不成立"}。`,
        {
          why: `${op} ${op === "beq" ? "在两数相等" : "在两数不等"}时跳转。跳转目标 ${label}（${hex(target)}）在汇编时就已写进这条指令（存的是相对下一条指令的距离 ${imm} 条）。`,
        },
      );
    } else if (compareZero[op] && rs) {
      const [cond, test] = compareZero[op];
      taken = test(rs.value);
      template = ["若 ", dim(rs.name), ` ${cond} → 跳到 `, label];
      beat(
        ["若 ", fresh(N(rs.value)), ` ${cond} → 跳到 `, label],
        `取 ${rs.name} 的值。`,
        reading([rs]),
      );
      beat(
        [
          fresh(taken ? "成立" : "不成立"),
          taken ? ` → 跳到 ${label}` : " → 继续下一条",
        ],
        `条件 ${rs.value} ${cond} ${taken ? "成立" : "不成立"}。`,
        {
          why: `${op} 把 ${rs.name} 当作有符号数与 0 比较。跳转目标 ${label}（${hex(target)}）在汇编时就已写进这条指令（存的是相对下一条指令的距离 ${imm} 条）。`,
        },
      );
    }
    const ra = written("$ra");
    if (ra)
      beat(["$ra = ", ok(N(ra.value, 4, "bits")), " ✓"], "保存返回地址。", {
        ...writing(ra, hex(ra.value)),
        why: "链接分支无论是否跳转都写 $ra。",
      });
    const dest = taken ? target : fallthrough;
    beat(
      ["下一条 = ", ok(where(dest)), " ✓"],
      taken ? "跳转。" : "顺序执行。",
      {
        tokens: [
          {
            from: "code",
            to: "next",
            label: taken ? "跳转" : "PC+4",
            kind: "flow",
          },
        ],
        why: delay
          ? "已开启延迟分支：紧跟在分支后的那条指令（延迟槽）总会先执行。"
          : "",
      },
    );
  } else if (/^(j|jal)$/.test(op)) {
    const label = where(ins.target);
    template =
      op === "jal" ? ["$ra ← 返回地址；跳到 ", label] : ["跳到 ", label];
    const ra = written("$ra");
    if (ra)
      beat(
        ["$ra = ", ok(N(ra.value, 4, "bits")), "；跳到 ", label],
        "保存返回地址。",
        {
          ...writing(ra, hex(ra.value)),
          why: `返回地址是${delay ? "延迟槽之后" : "下一条"}指令 ${where(ra.value)}，函数用 jr $ra 回到这里。`,
        },
      );
    beat(
      ["下一条 = ", ok(label), " ✓"],
      op === "jal" ? "进入函数。" : "跳转。",
      {
        tokens: [{ from: "code", to: "next", label, kind: "flow" }],
        why: `跳转目标 ${label}（${hex(ins.target)}）在汇编时就已写进这条指令。${delay ? "开启延迟分支时先执行延迟槽。" : ""}`,
      },
    );
  } else if (/^(jr|jalr)$/.test(op) && rs) {
    const back = op === "jr" && rs.name === "$ra";
    template = ["跳到 ", dim(rs.name), " 中的地址"];
    beat(["跳到 ", fresh(N(rs.value, 4, "bits"))], `取 ${rs.name} 的值。`, {
      ...reading([rs]),
      why: back
        ? "$ra 保存着 jal 留下的返回地址。"
        : "目标在运行时由寄存器决定。",
    });
    const link = op === "jalr" ? writes.find((a) => a.number === rdN) : null;
    if (link)
      beat(
        [link.name, " = ", ok(N(link.value, 4, "bits")), " ✓"],
        "保存返回地址。",
        writing(link, hex(link.value)),
      );
    beat(
      ["下一条 = ", ok(where(rs.value)), " ✓"],
      back ? "返回调用者。" : "跳转。",
      {
        tokens: [
          {
            from: "code",
            to: "next",
            label: back ? "返回" : hex(rs.value),
            kind: "flow",
          },
        ],
        why: delay ? "开启延迟分支时先执行延迟槽。" : "",
      },
    );
  } else if (op === "syscall") {
    const v0 = readNamed("$v0"),
      n = event.service ?? v0?.value,
      [title, args = []] = services[n] || ["系统服务"];
    template = ["syscall（", dim("$v0"), "）"];
    if (v0)
      beat(
        ["syscall ", fresh(N(n)), ` · ${title}`],
        "按 $v0 选择服务。",
        reading([v0]),
      );
    const params = reads.filter((a) => a !== v0 && args.includes(a.name));
    if (params.length)
      beat(
        params.flatMap((a, i) => [
          i ? "，" : "",
          a.name,
          " = ",
          fresh(N(a.value)),
        ]),
        "取参数的值。",
        reading(params),
      );
    if (event.status === "waiting-input")
      beat([fresh("等待输入")], "结果尚未产生，请在控制台提交输入。");
    for (const a of writes)
      beat(
        [a.name, " = ", ok(N(a.value)), " ✓"],
        `服务结果写入 ${a.name}。`,
        writing(a),
      );
    const stored = accesses.filter((a) => a.kind === "memory" && a.write);
    if (stored.length)
      beat(
        [
          `内存 ${hex(stored[0].address)} 起 `,
          ok(`${stored.reduce((s, a) => s + a.width, 0)} 字节`),
          " ✓",
        ],
        "服务把数据写入内存。",
        {
          lit: stored.map((a) => ({
            id: id(a),
            mode: "write",
            width: a.width,
          })),
        },
      );
    if (event.output)
      beat(["输出 ", ok(JSON.stringify(event.output))], "写到控制台。");
    if (n === 10 || n === 17)
      beat([ok("程序结束")], n === 17 ? "带返回码退出。" : "退出程序。");
  } else {
    // Instructions without a dedicated template still show their real accesses.
    if (reads.length)
      beat(
        reads.flatMap((a, i) => [
          i ? "，" : "",
          a.name,
          " = ",
          fresh(N(a.value)),
        ]),
        "读取。",
        reading(reads),
      );
    for (const a of accesses.filter((a) => a.write))
      beat(
        [
          a.kind === "register" ? a.name : `内存[${hex(a.address)}]`,
          " = ",
          ok(N(masked(a.value, a.width ?? 4))),
          " ✓",
        ],
        "写入。",
        writing(a, show(masked(a.value, a.width ?? 4))),
      );
    if (!beats.length)
      beat(
        [ok(op === "nop" ? "不做任何事" : "无寄存器或内存变化")],
        op === "nop" ? "空操作。" : "",
      );
  }
  if (event.error)
    beat([fresh("执行异常")], event.error.split("\n")[0], { why: event.error });

  const objects = new Map();
  for (const a of accesses) {
    const o = objects.get(id(a)) || {
      id: id(a),
      kind: a.kind,
      name: a.name,
      address: a.address,
      width: a.width,
      before: a.before ?? a.value,
      after: a.value,
      read: false,
      write: false,
    };
    if (a.write) {
      if (!o.write) o.before = a.before;
      o.after = a.value;
      o.write = true;
    } else o.read = true;
    objects.set(id(a), o);
  }
  const final = beats.at(-1)?.eq;
  return {
    template,
    beats,
    summary: final ? text(final).replace(/ ✓$/, "") : text(template),
    objects: [...objects.values()],
  };
}

function unique(list) {
  return [...new Map(list.map((a) => [id(a), a])).values()];
}

// Every beat answers "why?" (2026-10-22 trial, B2). Hand-written derivations
// above cover common instructions; for every other beat — and for
// instructions never seen before — the answer is generated from facts: the
// operand's role in the encoding, which earlier step produced the value, which
// later step uses the result, and how the next PC was chosen.
const LOADS = new Set([0x20, 0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x30]);
const STORES = new Set([0x28, 0x29, 0x2a, 0x2b, 0x2e, 0x38]);

function roleOf(ins, number, name) {
  const bits = ins.binary | 0,
    opcode = bits >>> 26,
    rs = (bits >>> 21) & 31,
    rt = (bits >>> 16) & 31,
    rd = (bits >>> 11) & 31;
  if (ins.op === "syscall") {
    if (name === "$v0")
      return " syscall 的服务编号（syscall 按 $v0 决定做什么）";
    if (/^\$a[0-3]$/.test(name)) return " syscall 服务的参数";
    return " syscall 服务用到的寄存器";
  }
  if (name === "hi" || name === "lo")
    return `${name.toUpperCase()} 寄存器（乘除法结果的存放处）`;
  if (LOADS.has(opcode) && number === rs) return "基址（地址 = 基址 + 偏移）";
  if (STORES.has(opcode) && number === rs) return "基址（地址 = 基址 + 偏移）";
  if (STORES.has(opcode) && number === rt) return "要存进内存的值";
  if (ins.flow === "branch")
    return number === rs ? "比较的第一个对象" : "比较的第二个对象";
  if (
    ins.flow === "indirect" ||
    (opcode === 0 && (bits & 63) === 9 && number === rs)
  )
    return "跳转目标地址";
  if (opcode === 0) {
    if (number === rs && number === rt) return "两个源操作数（两个位置都是它）";
    if (number === rs) return "第一个源操作数";
    if (number === rt) return "第二个源操作数";
    if (number === rd) return "目标";
  }
  if (number === rs) return "源操作数";
  if (number === rt) return "操作数";
  return "这条指令用到的一个寄存器";
}

function destField(ins, number) {
  const bits = ins.binary | 0,
    opcode = bits >>> 26;
  if (number === ((bits >>> 11) & 31) && opcode === 0)
    return "这条指令写明的目标寄存器";
  if (number === ((bits >>> 16) & 31) && opcode !== 0)
    return "这条指令写明的目标寄存器";
  if (number === 31 && (opcode === 3 || ins.flow === "call"))
    return "调用指令固定写 $ra";
  return "";
}

const touches = (a, id) => {
  if (id.startsWith("reg:"))
    return a.kind === "register" && a.name === id.slice(4);
  const address = Number(id.slice(4));
  return (
    a.kind === "memory" && address >= a.address && address < a.address + a.width
  );
};

export function completeWhys(
  model,
  event,
  {
    before = [],
    after = [],
    instructions = [],
    symbols = [],
    explanations = {},
    delay = false,
  } = {},
) {
  if (!event?.instruction || !model?.beats) return model;
  const ins = event.instruction;
  // A step is named by its source line (the pseudo-instruction a student
  // wrote, not its expansion), without the line's comment.
  const place = (e) => {
    const i = e.instruction,
      line =
        instructions.find(
          (x) => x.file === i.file && x.line === i.line && x.source,
        )?.source ||
        i.source ||
        i.basic ||
        i.op;
    return `第 ${e.step} 步（${i.file}:${i.line} \`${line.split("#")[0].trim().replace(/\s+/g, " ")}\`）`;
  };
  const where = (address) => {
    const s = symbols.find((x) => x.address === address && !x.data);
    if (s) return s.name;
    const i = instructions.find((x) => x.address === address);
    return i ? `${i.file} 第 ${i.line} 行` : hex(address);
  };
  const writer = (id) => {
    for (let k = before.length - 1; k >= 0; k--)
      if ((before[k].accesses || []).some((a) => a.write && touches(a, id)))
        return before[k];
    return null;
  };
  const reader = (id) =>
    after.find((e) =>
      (e.accesses || []).some((a) => !a.write && touches(a, id)),
    ) || null;
  const access = (id) => (event.accesses || []).find((a) => touches(a, id));
  const rule = () =>
    explanations[ins.op] || ins.description || "按这条指令的定义计算。";

  // provenanceOnly: the beat already explains its rule (a hand-written
  // derivation); add only where its inputs came from and where results go.
  const generate = (b, provenanceOnly = false) => {
    const reads = b.tokens.filter(
      (t) => t.kind === "read" && t.from !== "code",
    );
    const writes = b.lit.filter((l) => l.mode === "write");
    const flow = b.tokens.find((t) => t.to === "next");
    const parts = [];
    for (const t of reads) {
      const a = access(t.from);
      if (!a) continue;
      const w = writer(t.from);
      if (a.kind === "register") {
        if (a.name === "$zero") {
          if (!provenanceOnly) parts.push("$zero 恒为 0，读它总是得到 0。");
          continue;
        }
        if (provenanceOnly) {
          if (w) parts.push(`${a.name} 的值来自${place(w)}。`);
          continue;
        }
        parts.push(
          `${a.name} 在这里是${roleOf(ins, a.number, a.name)}。` +
            (w
              ? `它现在的值来自${place(w)}。`
              : "最近的执行记录里没有写过它，这是它的初始值或更早写入的值。"),
        );
      } else {
        parts.push(
          (provenanceOnly
            ? ""
            : `从内存 ${hex(a.address)} 取 ${a.width} 字节。`) +
            (w
              ? `这里的内容是${place(w)}写进去的。`
              : "最近的执行记录里没有写过这里，内容是程序加载时就有的数据（例如 .data 里的初值）。"),
        );
      }
    }
    for (const l of writes) {
      const a = access(l.id);
      if (!a) continue;
      const r = reader(l.id);
      const field = a.kind === "register" ? destField(ins, a.number) : "";
      const what = provenanceOnly
        ? ""
        : a.kind === "register"
          ? `结果写进 ${a.name}${field ? `（${field}）` : ""}。`
          : `结果写进内存 ${hex(a.address)} 起的 ${a.width} 字节。`;
      parts.push(
        what +
          (r
            ? `之后${place(r)}会读取它。`
            : "在窗口里之后的步骤不会再读取它。"),
      );
    }
    if (provenanceOnly) return parts.join("");
    if (flow && event.nextPC != null) {
      const sequential = event.nextPC === ins.address + 4;
      parts.push(
        sequential
          ? "没有发生跳转：PC（下一条要执行的指令地址）加 4，执行紧挨着的下一条指令。"
          : `下一条要执行的指令地址（PC）变成 ${hex(event.nextPC)}，也就是 ${where(event.nextPC)}。`,
      );
      if (delay && ins.flow !== "next")
        parts.push("已开启延迟分支：跳转前会先执行紧跟在后面的那一条。");
    }
    if (!parts.length) {
      if (event.output && event.service != null) {
        // Link the visible effect to the values that produced it (C1): facts
        // only — which registers the service read and which step wrote them.
        const args = (event.accesses || []).filter(
          (x) => x.kind === "register" && !x.write && x.name !== "$v0",
        );
        parts.push(
          `控制台在这一步多了 ${JSON.stringify(event.output)}。` +
            args
              .map((x) => {
                const w = writer("reg:" + x.name);
                return `这个 syscall 用到的 ${x.name} 等于 ${show(x.value)}${w ? `，是${place(w)}写入的` : ""}。`;
              })
              .join(""),
        );
      } else parts.push(`指令 ${ins.op} 的规则：${rule()}`);
    }
    return parts.join("");
  };
  return {
    ...model,
    beats: model.beats.map((b) =>
      b.why
        ? { ...b, why: [b.why, generate(b, true)].filter(Boolean).join(" ") }
        : { ...b, why: generate(b) },
    ),
  };
}

// Adjacent memory bytes of one step become one object (trial B4): shown as
// text when printable, with the raw bytes kept alongside.
export function groupBytes(objects) {
  const out = [];
  for (const o of objects) {
    const prev = out.at(-1);
    if (
      o.kind === "memory" &&
      prev?.kind === "memory" &&
      prev.address + prev.width === o.address &&
      prev.write === o.write
    ) {
      prev.width += o.width;
      prev.ids.push(o.id);
      prev.bytes.push(...bytesOf(o));
      continue;
    }
    out.push(
      o.kind === "memory"
        ? { ...o, ids: [o.id], bytes: bytesOf(o) }
        : { ...o, ids: [o.id] },
    );
  }
  // This is a byte view, not a syscall string: NUL stays visible, including
  // inside a buffer. Removing it would incorrectly turn A\0B into AB. Escapes
  // match ASCII mode (\0, \n, \t), not JSON's \u0000.
  for (const o of out)
    if (o.kind === "memory" && o.bytes.length > 1)
      o.text = o.bytes.every(
        (b) => b === 0 || b === 9 || b === 10 || (b >= 32 && b < 127),
      )
        ? '"' +
          o.bytes
            .map((b) => (b === 34 ? '\\"' : b === 92 ? "\\\\" : escapeByte(b)))
            .join("") +
          '"'
        : null;
  return out;
}

// Little-endian bytes of a recorded value (MARS's fixed byte order here).
function bytesOf(o) {
  return Array.from(
    { length: o.width },
    (_, i) => ((o.value ?? o.after) >>> (8 * i)) & 255,
  );
}

// One source line that expanded to several machine instructions, explained
// by its net effect (trial C3): values it read from outside the line, the
// final results (the assembler's $at is an intermediate), and where execution
// goes next. The per-instruction beats are shown only when expanded.
export function lineSummary(
  events,
  { source = "", instructions = [], symbols = [] } = {},
) {
  const first = events[0],
    last = events.at(-1);
  const where = (address) => {
    const s = symbols.find((x) => x.address === address && !x.data);
    if (s) return s.name;
    const i = instructions.find((x) => x.address === address);
    return i ? `第 ${i.line} 行` : hex(address);
  };
  const written = new Set(),
    reads = new Map(),
    writes = new Map(),
    firstBefore = new Map();
  for (const e of events)
    for (const a of e.accesses || []) {
      const key = id(a);
      if (
        !a.write &&
        !written.has(key) &&
        a.name !== "$zero" &&
        a.name !== "$at" &&
        !reads.has(key)
      )
        reads.set(key, a);
      if (a.write) {
        if (!written.has(key)) firstBefore.set(key, a.before);
        written.add(key);
        if (a.name !== "$at") writes.set(key, a);
      }
    }
  const expansion = events.map((e) => e.instruction.basic).join("；");
  const beats = [];
  const R = [...reads.values()],
    W = [...writes.values()];
  if (R.length)
    beats.push({
      eq: R.flatMap((a, i) => [
        i ? "，" : "",
        a.kind === "register" ? a.name : `内存[${hex(a.address)}]`,
        " = ",
        fresh(N(a.value, a.width || 4, a.kind === "memory" ? "bits" : "value")),
      ]),
      caption: `取 ${R.map((a) => a.name || hex(a.address)).join("、")} 的值。`,
      lit: R.map((a) => ({ id: id(a), mode: "read" })),
      tokens: R.map((a) => ({
        from: id(a),
        to: "code",
        label: show(a.value),
        kind: "read",
        value: N(a.value, a.width || 4),
      })),
      why: "",
    });
  if (W.length)
    beats.push({
      eq: [
        ...W.flatMap((a, i) => [
          i ? "，" : "",
          a.kind === "register" ? a.name : `内存[${hex(a.address)}]`,
          " = ",
          ok(
            N(
              a.kind === "memory" ? masked(a.value, a.width) : a.value,
              a.width || 4,
              a.kind === "memory" ? "bits" : "value",
            ),
          ),
        ]),
        " ✓",
      ],
      caption: `这一行的结果（伪指令，汇编时换成 ${events.length} 条机器指令）。`,
      lit: W.map((a) => ({ id: id(a), mode: "write" })),
      tokens: W.map((a) => ({
        from: "code",
        to: id(a),
        label: show(a.value),
        kind: "write",
        value: N(a.value, a.width || 4),
      })),
      why: `这一行是伪指令，展开为：${expansion}。在代码路径里点 ▸ 可以逐条查看每一步。`,
    });
  const jumped =
    last.nextPC != null && last.nextPC !== last.instruction.address + 4;
  if (jumped || !beats.length)
    beats.push({
      eq: ["下一条 = ", ok(where(last.nextPC)), " ✓"],
      caption: jumped ? "跳转。" : "顺序执行。",
      lit: [],
      tokens: [
        {
          from: "code",
          to: "next",
          label: jumped ? "跳转" : "PC+4",
          kind: "flow",
        },
      ],
      why: beats.length ? "" : `这一行是伪指令，展开为：${expansion}。`,
    });
  const accesses = [...R, ...W];
  return {
    template: [
      source || first.instruction.source?.trim() || first.instruction.basic,
    ],
    beats,
    summary: beats.at(-1) ? text(beats.at(-1).eq).replace(/ ✓$/, "") : "",
    objects: accesses.map((a) => ({
      id: id(a),
      kind: a.kind,
      name: a.name,
      address: a.address,
      width: a.width,
      before: a.write ? firstBefore.get(id(a)) : a.value,
      after: a.value,
      read: !a.write,
      write: !!a.write,
    })),
    // A single event standing for the whole line, for completeWhys.
    event: {
      ...first,
      accesses,
      nextPC: last.nextPC,
      output: events.map((e) => e.output || "").join(""),
      instruction: { ...first.instruction, source },
    },
  };
}
