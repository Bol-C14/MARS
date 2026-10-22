import { hex, registerNames, services } from "./model.js";
// Fill-in-the-blank explanation of one recorded step (DESIGN §3.7): a symbolic
// template, then beats that each substitute one recorded value. Values come
// only from the event's accesses; nothing here executes or predicts.

const dim = (t) => ({ t: String(t), c: "dim" });
const fresh = (t) => ({ t: String(t), c: "fresh" });
const ok = (t) => ({ t: String(t), c: "ok" });
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
    })),
  });
  const writing = (a, label = show(a.value)) => ({
    lit: [{ id: id(a), mode: "write" }],
    tokens: [{ from: "code", to: id(a), label, kind: "write" }],
  });
  // Base + offset → effective address. With a zero offset the base already is
  // the address, so one beat says both instead of repeating the same line.
  const addressing = (at, base, off, addr, width) => {
    const align =
      width > 1
        ? `${op} 要求地址是 ${width} 的倍数，否则触发地址异常。`
        : "按字节访问不需要对齐。";
    if (rs && imm !== 0) {
      beat(at([fresh(hex(rs.value)), off]), `读出基址 ${base}。`, {
        ...reading([rs]),
        why: `地址 = 基址寄存器 + 16 位有符号偏移（${imm}）。`,
      });
      beat(at([fresh(hex(addr))]), "得到地址。", {
        why: `${hex(rs.value)} + (${imm}) = ${hex(addr)}。${align}`,
      });
    } else if (rs)
      beat(at([fresh(hex(addr))]), `读出基址 ${base}，就是地址。`, {
        ...reading([rs]),
        why: `偏移为 0，地址就是 ${base} 的值。${align}`,
      });
    else beat(at([fresh(hex(addr))]), "得到地址。", { why: align });
  };
  // Final beat for a register result, or the explicit discard to $zero.
  const writeBack = (dest, value, asHex, why) => {
    const a = written(dest);
    if (a)
      beat([dest, " = ", ok(show(a.value, asHex)), " ✓"], `写回 ${dest}。`, {
        ...writing(a, show(a.value, asHex)),
        why,
      });
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
        ...expr(fresh(show(rs.value, asHex)), fresh(show(rt.value, asHex))),
      ],
      `读出 ${rs.name} 和 ${rt.name}。`,
      reading([rs, rt]),
    );
    if (res)
      beat([dest, " ← ", fresh(show(res.value, asHex))], "计算。", {
        why: rule,
      });
    writeBack(dest, res?.value, asHex);
  } else if (immediateOps[op] && rs) {
    const [sym, rule, logical] = immediateOps[op],
      dest = name(rtN),
      res = written(dest),
      k = logical ? hex(uimm) : String(imm);
    template = [dest, " ← ", dim(rs.name), ` ${sym} ${k}`];
    beat(
      [dest, " ← ", fresh(show(rs.value, logical)), ` ${sym} ${k}`],
      `读出 ${rs.name}。`,
      reading([rs]),
    );
    if (res)
      beat([dest, " ← ", fresh(show(res.value, logical))], "计算。", {
        why: rule,
      });
    writeBack(dest, res?.value, logical);
  } else if (op === "lui") {
    const dest = name(rtN);
    template = [dest, " ← ", dim(hex(uimm)), " << 16"];
    const res = written(dest);
    if (res)
      beat([dest, " ← ", fresh(hex(res.value))], "立即数放到高 16 位。", {
        why: `${hex(uimm)} 左移 16 位，低 16 位补 0。常与 ori 组合装入 32 位常数（la / li 展开）。`,
      });
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
        fresh(hex(rt.value)),
        ` ${sym} `,
        variable ? fresh(amount) : String(sa),
      ],
      `读出 ${rt.name}${variable ? " 和移位量" : ""}。`,
      reading(variable && rs ? [rt, rs] : [rt]),
    );
    if (res)
      beat([dest, " ← ", fresh(hex(res.value))], "移位。", {
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
        ? ["LO, HI ← ", fresh(rs.value), " ÷ ", fresh(rt.value)]
        : ["HI:LO ← ", acc, fresh(rs.value), " × ", fresh(rt.value)],
      `读出 ${rs.name} 和 ${rt.name}。`,
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
          ? ["商 ", fresh(L.value), "，余数 ", fresh(H.value)]
          : ["HI:LO ← ", fresh(p64)],
        division ? "整数除法。" : "得到 64 位乘积。",
        {
          why: division
            ? `商放入 LO，余数放入 HI。${unsigned ? "按无符号数计算。" : "商向 0 取整，余数与被除数同号。"}`
            : `${unsigned ? "按无符号数" : "按有符号数"}相乘，结果有 64 位：高 32 位进 HI，低 32 位进 LO。`,
        },
      );
      beat(
        ["HI = ", ok(show(H.value)), "，LO = ", ok(show(L.value)), " ✓"],
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
        [dest, " ← ", fresh(show(src.value))],
        `读出 ${op === "mfhi" ? "HI" : "LO"}。`,
        reading([src]),
      );
    writeBack(dest);
  } else if (/^(mthi|mtlo)$/.test(op) && rs) {
    const dest = op === "mthi" ? "hi" : "lo";
    template = [dest.toUpperCase(), " ← ", dim(rs.name)];
    beat(
      [dest.toUpperCase(), " ← ", fresh(show(rs.value))],
      `读出 ${rs.name}。`,
      reading([rs]),
    );
    const a = written(dest);
    if (a)
      beat(
        [dest.toUpperCase(), " = ", ok(show(a.value)), " ✓"],
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
        fresh(rt.value),
        ` ${cond} 0：`,
        dest,
        " ← ",
        fresh(show(rs.value)),
      ],
      "读出条件和数据。",
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
      [dest, " ← ", fresh(width === 4 ? show(mem.value) : byteHex(raw, width))],
      `读出 ${width} 字节。`,
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
        [dest, " ← ", fresh(show(res.value))],
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
          fresh(width === 4 ? show(src.value) : byteHex(value, width)),
        ],
        width === 4
          ? `读出 ${src.name}。`
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
        ok(width === 4 ? show(value) : byteHex(value, width)),
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
          fresh(rs.value),
          ` ${sym} `,
          fresh(rt.value),
          " → 跳到 ",
          label,
        ],
        "读出要比较的两个寄存器。",
        reading([rs, rt]),
      );
      beat(
        [
          fresh(taken ? "成立" : "不成立"),
          taken ? ` → 跳到 ${label}` : " → 继续下一条",
        ],
        "比较结果。",
        {
          why: `${op} ${op === "beq" ? "在两数相等" : "在两数不等"}时跳转。目标在汇编时已算好：PC+4 + (${imm})×4 = ${hex(target)}。`,
        },
      );
    } else if (compareZero[op] && rs) {
      const [cond, test] = compareZero[op];
      taken = test(rs.value);
      template = ["若 ", dim(rs.name), ` ${cond} → 跳到 `, label];
      beat(
        ["若 ", fresh(rs.value), ` ${cond} → 跳到 `, label],
        `读出 ${rs.name}。`,
        reading([rs]),
      );
      beat(
        [
          fresh(taken ? "成立" : "不成立"),
          taken ? ` → 跳到 ${label}` : " → 继续下一条",
        ],
        "比较结果。",
        {
          why: `${op} 把 ${rs.name} 当作有符号数与 0 比较。目标 = PC+4 + (${imm})×4 = ${hex(target)}。`,
        },
      );
    }
    const ra = written("$ra");
    if (ra)
      beat(["$ra = ", ok(hex(ra.value)), " ✓"], "保存返回地址。", {
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
      beat(["$ra = ", ok(hex(ra.value)), "；跳到 ", label], "保存返回地址。", {
        ...writing(ra, hex(ra.value)),
        why: `返回地址是${delay ? "延迟槽之后" : "下一条"}指令 ${where(ra.value)}，函数用 jr $ra 回到这里。`,
      });
    beat(
      ["下一条 = ", ok(label), " ✓"],
      op === "jal" ? "进入函数。" : "跳转。",
      {
        tokens: [{ from: "code", to: "next", label, kind: "flow" }],
        why: `目标 = (PC+4) 的高 4 位 | 指令中的 26 位 × 4 = ${hex(ins.target)}。${delay ? "开启延迟分支时先执行延迟槽。" : ""}`,
      },
    );
  } else if (/^(jr|jalr)$/.test(op) && rs) {
    const back = op === "jr" && rs.name === "$ra";
    template = ["跳到 ", dim(rs.name), " 中的地址"];
    beat(["跳到 ", fresh(hex(rs.value))], `读出 ${rs.name}。`, {
      ...reading([rs]),
      why: back
        ? "$ra 保存着 jal 留下的返回地址。"
        : "目标在运行时由寄存器决定。",
    });
    const link = op === "jalr" ? writes.find((a) => a.number === rdN) : null;
    if (link)
      beat(
        [link.name, " = ", ok(hex(link.value)), " ✓"],
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
        ["syscall ", fresh(n), ` · ${title}`],
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
          fresh(show(a.value)),
        ]),
        "读出参数。",
        reading(params),
      );
    if (event.status === "waiting-input")
      beat([fresh("等待输入")], "结果尚未产生，请在控制台提交输入。");
    for (const a of writes)
      beat(
        [a.name, " = ", ok(show(a.value)), " ✓"],
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
          fresh(show(a.value)),
        ]),
        "读取。",
        reading(reads),
      );
    for (const a of accesses.filter((a) => a.write))
      beat(
        [
          a.kind === "register" ? a.name : `内存[${hex(a.address)}]`,
          " = ",
          ok(show(masked(a.value, a.width ?? 4))),
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
