import { t, localized } from "./i18n/index.js";
import { marsText } from "./i18n/mars.js";
import { hex, registerNames, services } from "./model.js";
import { escapeByte } from "./radix.js";
import { serviceGuide, argumentMeaning } from "./syscalls.js";
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

const binaryOps = localized(() => ({
  add: ["+", t("beat.op.add")],
  addu: ["+", t("beat.op.addu")],
  sub: ["−", t("beat.op.sub")],
  subu: ["−", t("beat.op.subu")],
  and: ["&", t("beat.op.and"), true],
  or: ["|", t("beat.op.or"), true],
  xor: ["^", t("beat.op.xor"), true],
  nor: ["nor", t("beat.op.nor"), true],
  slt: ["<", t("beat.op.slt")],
  sltu: ["<ᵤ", t("beat.op.sltu")],
  mul: ["×", t("beat.op.mul")],
}));
const immediateOps = localized(() => ({
  addi: ["+", t("beat.op.addi")],
  addiu: ["+", t("beat.op.addiu")],
  slti: ["<", t("beat.op.slti")],
  sltiu: ["<ᵤ", t("beat.op.sltiu")],
  andi: ["&", t("beat.op.andi"), true],
  ori: ["|", t("beat.op.ori"), true],
  xori: ["^", t("beat.op.xori"), true],
}));
const shiftOps = localized(() => ({
  sll: ["<<", t("beat.op.sll")],
  srl: [">>>", t("beat.op.srl")],
  sra: [">>", t("beat.op.sra")],
  sllv: ["<<", t("beat.op.sllv")],
  srlv: [">>>", t("beat.op.srlv")],
  srav: [">>", t("beat.op.srav")],
}));
const compareZero = {
  blez: ["≤ 0", (v) => v <= 0],
  bgtz: ["> 0", (v) => v > 0],
  bltz: ["< 0", (v) => v < 0],
  bgez: ["≥ 0", (v) => v >= 0],
  bltzal: ["< 0", (v) => v < 0],
  bgezal: ["≥ 0", (v) => v >= 0],
};
const loads = localized(() => ({
  lw: [4, t("beat.memory"), false],
  ll: [4, t("beat.memory"), false],
  lh: [2, t("beat.halfword"), true],
  lhu: [2, t("beat.halfword"), false],
  lb: [1, t("beat.byte"), true],
  lbu: [1, t("beat.byte"), false],
}));
const stores = localized(() => ({
  sw: [4, t("beat.memory")],
  sc: [4, t("beat.memory")],
  sh: [2, t("beat.halfword")],
  sb: [1, t("beat.byte")],
}));

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
    return i ? t("common.lineN", { line: i.line }) : hex(address);
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
          eq: [fresh(event.status === "ended" ? t("block.ended") : t("beat.cannotRun"))],
          caption:
            event.status === "ended"
              ? t("beat.neverAgain")
              : String(event.status ?? ""),
          lit: [],
          tokens: [],
          why: "",
        },
      ],
      summary: event.status === "ended" ? t("block.ended") : t("beat.cannotRun"),
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
        ? t("beat.align", { op, width })
        : t("beat.align.byte");
    if (rs && imm !== 0) {
      beat(at([fresh(N(rs.value, 4, "bits")), off]), t("beat.base", { base }), {
        ...reading([rs]),
        why: t("beat.address", { imm }),
      });
      beat(at([fresh(N(addr, 4, "bits"))]), t("beat.address.done"), {
        why: `${hex(rs.value)} + (${imm}) = ${hex(addr)}${t("common.period")}${align}`,
      });
    } else if (rs)
      beat(
        at([fresh(N(addr, 4, "bits"))]),
        t("beat.base.isAddress", { base }),
        {
          ...reading([rs]),
          why: t("beat.offsetZero", { base, align }),
        },
      );
    else beat(at([fresh(N(addr, 4, "bits"))]), t("beat.address.done"), { why: align });
  };
  // Final beat for a register result, or the explicit discard to $zero.
  const writeBack = (dest, value, asHex, why) => {
    const a = written(dest);
    if (a)
      beat(
        [dest, " = ", ok(N(a.value, 4, asHex ? "bits" : "value")), " ✓"],
        t("beat.writeBack", { dest }),
        {
          ...writing(a, show(a.value, asHex)),
          why,
        },
      );
    else if (dest === "$zero")
      beat([dest, " = ", ok("0"), " ✓"], t("beat.zero.discard"), {
        why: t("beat.zero.noEffect"),
      });
  };

  // $zero is the identity of these operations (x + 0 = x, x | 0 = x), so
  // the meaning a student needs is a copy or a constant — whether the source
  // said move, li or wrote the instruction itself (round-3 trial: `move` was
  // read as an addition).
  const copyFrom =
    /^(add|addu|or|xor)$/.test(op) && (rsN === 0 || rtN === 0)
      ? rsN === 0
        ? rtN
        : rsN
      : /^(sub|subu)$/.test(op) && rtN === 0
        ? rsN
        : null;
  const loadsConstant = /^(addi|addiu|ori|xori)$/.test(op) && rsN === 0;
  if (copyFrom != null) {
    const dest = name(rdN),
      src = copyFrom === 0 ? null : read(copyFrom),
      res = written(dest);
    if (!src) {
      template = [dest, " ← 0"];
      if (res)
        beat([dest, " = ", ok(N(res.value)), " ✓"], t("beat.putZero", { dest }), {
          ...writing(res),
          why: t("beat.putZero.why"),
        });
      else writeBack(dest);
    } else {
      template = [dest, " ← ", dim(src.name)];
      beat(
        [dest, " ← ", fresh(N(src.value))],
        t("beat.take", { name: src.name }),
        reading([src]),
      );
      if (res)
        beat(
          [dest, " = ", ok(N(res.value)), " ✓"],
          t("beat.copy", { name: src.name, dest }),
          {
            ...writing(res),
            why: t("beat.copy.why", { name: src.name, operation: /^(add|addu)$/.test(op) ? t("beat.copy.add") : /^(sub|subu)$/.test(op) ? t("beat.copy.sub") : op === "or" ? t("beat.copy.or") : t("beat.copy.xor"), name: src.name, name: src.name }),
          },
        );
      else writeBack(dest);
    }
  } else if (loadsConstant) {
    const dest = name(rtN),
      k = /^(ori|xori)$/.test(op) ? uimm : imm,
      res = written(dest);
    template = [dest, " ← ", String(k)];
    if (res)
      beat(
        [dest, " = ", ok(N(res.value)), " ✓"],
        t("beat.putConstant", { k, dest }),
        {
          ...writing(res),
          why: t("beat.putConstant.why", { operation: /^addi/.test(op) ? t("beat.putConstant.add") : t("beat.putConstant.or"), k }),
        },
      );
    else writeBack(dest);
  } else if (binaryOps[op] && rs && rt) {
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
      t("beat.takeTwo", { a: rs.name, b: rt.name }),
      reading([rs, rt]),
    );
    if (res)
      beat(
        [dest, " ← ", fresh(N(res.value, 4, asHex ? "bits" : "value"))],
        /^sltu?$/.test(op)
          ? t("beat.compare", { a: rs.value, sym, b: rt.value, verdict: res.value ? t("beat.true") : t("beat.false"), result: res.value })
          : t("beat.compute"),
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
      t("beat.take", { name: rs.name }),
      reading([rs]),
    );
    if (res)
      beat(
        [dest, " ← ", fresh(N(res.value, 4, logical ? "bits" : "value"))],
        /^sltiu?$/.test(op)
          ? t("beat.compareImmediate", { a: rs.value, sym, k, verdict: res.value ? t("beat.true") : t("beat.false"), result: res.value })
          : t("beat.compute"),
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
        t("beat.lui"),
        {
          why: t("beat.lui.why", { uimm: hex(uimm) }),
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
      t("beat.shift.take", { name: rt.name, amount: variable ? ` ${t("beat.shift.andAmount")}` : "" }),
      reading(variable && rs ? [rt, rs] : [rt]),
    );
    if (res)
      beat([dest, " ← ", fresh(N(res.value, 4, "bits"))], t("beat.shift"), {
        why:
          rule +
          (variable && rs
            ? ` ${t("beat.shift.amount", { name: rs.name, value: rs.value, amount })}`
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
      t("beat.takeTwo", { a: rs.name, b: rt.name }),
      reading([rs, rt]),
    );
    if (division && rt.value === 0)
      beat([`${t("beat.div.divisor")} `, fresh("0")], t("beat.div.zero"), {
        why: t("beat.div.zero.why"),
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
          ? [`${t("beat.div.quotient")} `, fresh(N(L.value)), `${t("beat.div.remainder")} `, fresh(N(H.value))]
          : ["HI:LO ← ", fresh(p64)],
        division ? t("beat.div") : t("beat.mult"),
        {
          why: division
            ? t("beat.div.why", { rule: unsigned ? t("beat.div.unsigned") : t("beat.div.signed") })
            : t("beat.mult.why", { kind: unsigned ? t("beat.mult.unsigned") : t("beat.mult.signed") }),
        },
      );
      beat(
        ["HI = ", ok(N(H.value)), t("common.comma") + "LO = ", ok(N(L.value)), " ✓"],
        t("beat.hilo"),
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
            ? t("beat.div.read")
            : t("beat.mult.read"),
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
        t("beat.takeHiLo", { reg: op === "mfhi" ? "HI" : "LO" }),
        reading([src]),
      );
    writeBack(dest);
  } else if (/^(mthi|mtlo)$/.test(op) && rs) {
    const dest = op === "mthi" ? "hi" : "lo";
    template = [dest.toUpperCase(), " ← ", dim(rs.name)];
    beat(
      [dest.toUpperCase(), " ← ", fresh(N(rs.value))],
      t("beat.take", { name: rs.name }),
      reading([rs]),
    );
    const a = written(dest);
    if (a)
      beat(
        [dest.toUpperCase(), " = ", ok(N(a.value)), " ✓"],
        t("beat.writeHiLo", { reg: dest.toUpperCase() }),
        writing(a),
      );
  } else if (/^(movn|movz)$/.test(op) && rs && rt) {
    const dest = name(rdN),
      cond = op === "movn" ? "≠" : "==",
      yes = op === "movn" ? rt.value !== 0 : rt.value === 0;
    template = [`${t("beat.if")} `, dim(rt.name), ` ${cond} 0${t("common.colon")}`, dest, " ← ", dim(rs.name)];
    beat(
      [
        `${t("beat.if")} `,
        fresh(N(rt.value)),
        ` ${cond} 0${t("common.colon")}`,
        dest,
        " ← ",
        fresh(N(rs.value)),
      ],
      t("beat.mov.take"),
      reading([rt, rs]),
    );
    beat(
      [fresh(yes ? t("beat.holds") : t("beat.fails")), yes ? ` ${t("beat.mov.copy", { dest })}` : ` ${t("beat.mov.skip")}`],
      t("beat.mov.test"),
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
      t("beat.load", { width }),
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
            ? t("beat.load.byte", { byte: byteHex(raw, 1) })
            : t("beat.load.endian", { memory: littleEndian(addr, raw, width), value: byteHex(raw, width) }),
      },
    );
    const res = written(dest);
    if (width < 4 && res) {
      const top = raw >>> (8 * width - 1);
      beat(
        [dest, " ← ", fresh(N(res.value))],
        signed
          ? t("beat.load.extend", { top, fill: top ? t("beat.load.fillOne") : t("beat.load.fillZero") })
          : t("beat.load.zeroExtend"),
        {
          why: signed
            ? t("beat.load.signExtend.why", { op, bytes: byteHex(raw, width), top, top, hex: hex(res.value), value: res.value, op, raw })
            : t("beat.load.zeroExtend.why", { op, hex: hex(res.value), value: res.value, signed: op.slice(0, -1) }),
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
          ? t("beat.take", { name: src.name })
          : t("beat.store.take", { name: src.name, width: 8 * width }),
        {
          ...reading([src]),
          why:
            width === 4
              ? `${src.name} = ${show(src.value)}${t("common.period")}`
              : t("beat.store.keep", { name: src.name, value: hex(src.value), width: 8 * width, kept: byteHex(value, width) }),
        },
      );
    beat(
      [
        `${unit}[ ${hex(addr)} ] = `,
        ok(N(value, width, width === 4 ? "value" : "bits")),
        " ✓",
      ],
      t("beat.store", { width }),
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
            ? t("beat.store.overwritten", { before: byteHex(mem.before, 1) })
            : t("beat.store.endian", { bytes: littleEndian(addr, value, width) }),
      },
    );
  } else if (ins.flow === "branch") {
    const target = ins.target,
      label = where(target),
      fallthrough = ins.address + (delay ? 8 : 4);
    const always =
      op === "beq" ? rsN === rtN : rsN === 0 && /^(bgez|blez|bgezal)$/.test(op);
    let taken = always;
    if (always) template = [`${t("beat.goTo")} `, label];
    else if (/^(beq|bne)$/.test(op) && rs && rt && (rsN === 0 || rtN === 0)) {
      // Comparing with $zero is comparing with the number 0 (beqz, bnez).
      const x = rsN === 0 ? rt : rs,
        sym = op === "beq" ? "==" : "≠";
      taken = op === "beq" ? x.value === 0 : x.value !== 0;
      template = [`${t("beat.if")} `, dim(x.name), ` ${t("beat.ifZero", { sym })} `, label];
      beat(
        [`${t("beat.if")} `, fresh(N(x.value)), ` ${t("beat.ifZero", { sym })} `, label],
        t("beat.take", { name: x.name }),
        reading([x]),
      );
      beat(
        [
          fresh(taken ? t("beat.holds") : t("beat.fails")),
          taken ? ` ${t("beat.thenGoTo", { label })}` : ` ${t("beat.thenNext")}`,
        ],
        t("beat.condZero", { value: x.value, sym, verdict: taken ? t("beat.holds") : t("beat.fails") }),
        {
          why: t("beat.condZero.why", { name: x.name, test: op === "beq" ? t("beat.equalZero") : t("beat.notZero"), label, target: hex(target) }),
        },
      );
    } else if (/^(beq|bne)$/.test(op) && rs && rt) {
      const sym = op === "beq" ? "==" : "≠";
      taken = op === "beq" ? rs.value === rt.value : rs.value !== rt.value;
      template = [
        `${t("beat.if")} `,
        dim(rs.name),
        ` ${sym} `,
        dim(rt.name),
        ` ${t("beat.arrowGoTo")} `,
        label,
      ];
      beat(
        [
          `${t("beat.if")} `,
          fresh(N(rs.value)),
          ` ${sym} `,
          fresh(N(rt.value)),
          ` ${t("beat.arrowGoTo")} `,
          label,
        ],
        t("beat.takeCompared"),
        reading([rs, rt]),
      );
      beat(
        [
          fresh(taken ? t("beat.holds") : t("beat.fails")),
          taken ? ` ${t("beat.thenGoTo", { label })}` : ` ${t("beat.thenNext")}`,
        ],
        t("beat.cond", { a: rs.value, sym, b: rt.value, verdict: taken ? t("beat.holds") : t("beat.fails") }),
        {
          why: t("beat.cond.why", { op, when: op === "beq" ? t("beat.whenEqual") : t("beat.whenDifferent"), label, target: hex(target), imm }),
        },
      );
    } else if (compareZero[op] && rs) {
      const [cond, test] = compareZero[op];
      taken = test(rs.value);
      template = [`${t("beat.if")} `, dim(rs.name), ` ${t("beat.condGoTo", { cond })} `, label];
      beat(
        [`${t("beat.if")} `, fresh(N(rs.value)), ` ${t("beat.condGoTo", { cond })} `, label],
        t("beat.take", { name: rs.name }),
        reading([rs]),
      );
      beat(
        [
          fresh(taken ? t("beat.holds") : t("beat.fails")),
          taken ? ` ${t("beat.thenGoTo", { label })}` : ` ${t("beat.thenNext")}`,
        ],
        t("beat.condSigned", { value: rs.value, cond, verdict: taken ? t("beat.holds") : t("beat.fails") }),
        {
          why: t("beat.condSigned.why", { op, name: rs.name, label, target: hex(target), imm }),
        },
      );
    }
    const ra = written("$ra");
    if (ra)
      beat(["$ra = ", ok(N(ra.value, 4, "bits")), " ✓"], t("beat.saveReturn"), {
        ...writing(ra, hex(ra.value)),
        why: t("beat.saveReturn.link"),
      });
    const dest = taken ? target : fallthrough;
    beat(
      [`${t("beat.next")} `, ok(where(dest)), " ✓"],
      taken ? t("beat.jump") : t("beat.inOrder"),
      {
        tokens: [
          {
            from: "code",
            to: "next",
            label: taken ? t("path.edge.jump") : "PC+4",
            kind: "flow",
          },
        ],
        why: delay
          ? t("beat.delay.branch")
          : "",
      },
    );
  } else if (/^(j|jal)$/.test(op)) {
    const label = where(ins.target);
    template =
      op === "jal" ? [`${t("beat.jal.template")} `, label] : [`${t("beat.goTo")} `, label];
    const ra = written("$ra");
    if (ra)
      beat(
        ["$ra = ", ok(N(ra.value, 4, "bits")), `${t("beat.jal.goTo")} `, label],
        t("beat.saveReturn"),
        {
          ...writing(ra, hex(ra.value)),
          why: t("beat.jal.why", { which: delay ? t("beat.jal.afterSlot") : t("beat.jal.next"), value: where(ra.value) }),
        },
      );
    beat(
      [`${t("beat.next")} `, ok(label), " ✓"],
      op === "jal" ? t("beat.jal") : t("beat.jump"),
      {
        tokens: [{ from: "code", to: "next", label, kind: "flow" }],
        why: t("beat.jump.why", { label, target: hex(ins.target), delay: delay ? t("beat.jump.delay") : "" }),
      },
    );
  } else if (/^(jr|jalr)$/.test(op) && rs) {
    const back = op === "jr" && rs.name === "$ra";
    template = [`${t("beat.goTo")} `, dim(rs.name), ` ${t("beat.jr.address")}`];
    beat([`${t("beat.goTo")} `, fresh(N(rs.value, 4, "bits"))], t("beat.take", { name: rs.name }), {
      ...reading([rs]),
      why: back
        ? t("beat.jr.ra")
        : t("beat.jr.runtime"),
    });
    const link = op === "jalr" ? writes.find((a) => a.number === rdN) : null;
    if (link)
      beat(
        [link.name, " = ", ok(N(link.value, 4, "bits")), " ✓"],
        t("beat.saveReturn"),
        writing(link, hex(link.value)),
      );
    beat(
      [`${t("beat.next")} `, ok(where(rs.value)), " ✓"],
      back ? t("beat.return") : t("beat.jump"),
      {
        tokens: [
          {
            from: "code",
            to: "next",
            label: back ? t("path.edge.return") : hex(rs.value),
            kind: "flow",
          },
        ],
        why: delay ? t("beat.jump.delay") : "",
      },
    );
  } else if (op === "syscall") {
    const v0 = readNamed("$v0"),
      n = event.service ?? v0?.value,
      [title, args = []] = services[n] || [t("beat.syscall")];
    // What the service does and what each argument means come from the
    // per-service guide (classroom 2026-10-24), e.g. 45 is '-' for service 11.
    const guide = serviceGuide[n];
    template = ["syscall" + t("common.openParen"), dim("$v0"), t("common.closeParen")];
    if (v0)
      beat(
        ["$v0 = ", fresh(N(n)), ` → ${guide?.[0] || title}`],
        guide ? t("beat.syscall.chooses", { what: guide[1] }) : t("beat.syscall.choosesPlain"),
        {
          ...reading([v0]),
          why: guide
            ? t("beat.syscall.chosen", { n, name: guide[0], effect: guide[3], changes: guide[4] })
            : t("beat.syscall.unsupported", { n }),
        },
      );
    const params = reads.filter((a) => a !== v0 && args.includes(a.name));
    if (params.length) {
      const meaning = (a) => guide?.[2].find(([r]) => r === a.name)?.[1];
      beat(
        params.flatMap((a, i) => [
          i ? t("common.comma") : "",
          a.name,
          " = ",
          fresh(N(a.value)),
        ]),
        params
          .map((a) => {
            const m = argumentMeaning(n, a.name, a.value);
            return `${a.name}${t("common.colon")}${meaning(a) || t("beat.syscall.argument")}${m ? t("common.inParens", { text: m }) : ""}`;
          })
          .join(t("common.semicolon")) + t("common.period"),
        reading(params),
      );
    }
    if (event.status === "waiting-input")
      beat([fresh(t("beat.waiting"))], t("beat.waiting.note"));
    for (const a of writes)
      beat(
        [a.name, " = ", ok(N(a.value)), " ✓"],
        t("beat.result", { name: a.name }),
        writing(a),
      );
    const stored = accesses.filter((a) => a.kind === "memory" && a.write);
    if (stored.length)
      beat(
        [
          `${t("beat.memoryFrom", { address: hex(stored[0].address) })} `,
          ok(t("beat.bytes", { width: stored.reduce((s, a) => s + a.width, 0) })),
          " ✓",
        ],
        t("beat.writeMemory"),
        {
          lit: stored.map((a) => ({
            id: id(a),
            mode: "write",
            width: a.width,
          })),
        },
      );
    if (event.output)
      beat([`${t("beat.output")} `, ok(JSON.stringify(event.output))], t("beat.toConsole"));
    if (n === 10 || n === 17)
      beat([ok(t("beat.programEnds"))], n === 17 ? t("beat.exitCode") : t("beat.exit"));
  } else {
    // Instructions without a dedicated template still show their real accesses.
    if (reads.length)
      beat(
        reads.flatMap((a, i) => [
          i ? t("common.comma") : "",
          a.name,
          " = ",
          fresh(N(a.value)),
        ]),
        t("beat.read"),
        reading(reads),
      );
    for (const a of accesses.filter((a) => a.write))
      beat(
        [
          a.kind === "register" ? a.name : t("inspector.memoryCell", { address: hex(a.address) }),
          " = ",
          ok(N(masked(a.value, a.width ?? 4))),
          " ✓",
        ],
        t("beat.write"),
        writing(a, show(masked(a.value, a.width ?? 4))),
      );
    if (!beats.length)
      beat(
        [ok(op === "nop" ? t("beat.nop") : t("beat.nop.changes"))],
        op === "nop" ? t("beat.nop.what") : "",
      );
  }
  if (event.error)
    beat([fresh(t("beat.exception"))], marsText(event.error).split("\n")[0], { why: marsText(event.error) });

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
      return t("beat.role.v0");
    if (/^\$a[0-3]$/.test(name)) return t("beat.role.argument");
    return t("beat.role.syscallRegister");
  }
  if (name === "hi" || name === "lo")
    return t("beat.role.hilo", { reg: name.toUpperCase() });
  if (LOADS.has(opcode) && number === rs) return t("beat.role.base");
  if (STORES.has(opcode) && number === rs) return t("beat.role.base");
  if (STORES.has(opcode) && number === rt) return t("beat.role.stored");
  if (ins.flow === "branch")
    return number === rs ? t("beat.role.compareFirst") : t("beat.role.compareSecond");
  if (
    ins.flow === "indirect" ||
    (opcode === 0 && (bits & 63) === 9 && number === rs)
  )
    return t("beat.role.jumpTarget");
  if (opcode === 0) {
    if (number === rs && number === rt) return t("beat.role.bothSources");
    if (number === rs) return t("beat.role.firstSource");
    if (number === rt) return t("beat.role.secondSource");
    if (number === rd) return t("beat.role.target");
  }
  if (number === rs) return t("beat.role.source");
  if (number === rt) return t("beat.role.operand");
  return t("beat.role.used");
}

function destField(ins, number) {
  const bits = ins.binary | 0,
    opcode = bits >>> 26;
  if (number === ((bits >>> 11) & 31) && opcode === 0)
    return t("beat.role.namedTarget");
  if (number === ((bits >>> 16) & 31) && opcode !== 0)
    return t("beat.role.namedTarget");
  if (number === 31 && (opcode === 3 || ins.flow === "call"))
    return t("beat.role.callRa");
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
    return t("beat.place.step", { step: e.step, file: i.file, line: i.line, code: line.split("#")[0].trim().replace(/\s+/g, " ") });
  };
  const where = (address) => {
    const s = symbols.find((x) => x.address === address && !x.data);
    if (s) return s.name;
    const i = instructions.find((x) => x.address === address);
    return i ? t("common.fileLine", { file: i.file, line: i.line }) : hex(address);
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
    explanations[ins.op] || ins.description || t("beat.byDefinition");

  // provenanceOnly: the beat already explains its rule (a hand-written
  // derivation); add only where its inputs came from and where results go.
  const generate = (b, provenanceOnly = false) => {
    const reads = b.tokens.filter(
      (t) => t.kind === "read" && t.from !== "code",
    );
    const writes = b.lit.filter((l) => l.mode === "write");
    const flow = b.tokens.find((t) => t.to === "next");
    const parts = [];
    for (const token of reads) {
      const a = access(token.from);
      if (!a) continue;
      const w = writer(token.from);
      if (a.kind === "register") {
        if (a.name === "$zero") {
          if (!provenanceOnly) parts.push(t("beat.why.zero"));
          continue;
        }
        if (provenanceOnly) {
          if (w) parts.push(t("beat.why.from", { name: a.name, place: place(w) }));
          continue;
        }
        parts.push(
          t("beat.why.role", { name: a.name, role: roleOf(ins, a.number, a.name) }) +
            (w
              ? t("beat.why.nowFrom", { place: place(w) })
              : t("beat.why.initial")),
        );
      } else {
        parts.push(
          (provenanceOnly
            ? ""
            : t("beat.why.load", { address: hex(a.address), width: a.width })) +
            (w
              ? t("beat.why.memoryFrom", { place: place(w) })
              : t("beat.why.memoryInitial")),
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
          ? t("beat.why.writes", { name: a.name, field: field ? t("common.inParens", { text: field }) : "" })
          : t("beat.why.writesMemory", { address: hex(a.address), width: a.width });
      parts.push(
        what +
          (r
            ? t("beat.why.readLater", { place: place(r) })
            : t("beat.why.notReadLater")),
      );
    }
    if (provenanceOnly) return parts.join("");
    if (flow && event.nextPC != null) {
      const sequential = event.nextPC === ins.address + 4;
      parts.push(
        sequential
          ? t("beat.why.pcPlus4")
          : t("beat.why.pcTo", { pc: hex(event.nextPC), where: where(event.nextPC) }),
      );
      if (delay && ins.flow !== "next")
        parts.push(t("beat.why.delay"));
    }
    if (!parts.length) {
      if (event.output && event.service != null) {
        // Link the visible effect to the values that produced it (C1): facts
        // only — which registers the service read and which step wrote them.
        const args = (event.accesses || []).filter(
          (x) => x.kind === "register" && !x.write && x.name !== "$v0",
        );
        parts.push(
          t("beat.why.output", { output: JSON.stringify(event.output) }) +
            args
              .map((x) => {
                const w = writer("reg:" + x.name);
                return t("beat.why.syscallArg", { name: x.name, value: show(x.value), from: w ? t("beat.why.writtenBy", { place: place(w) }) : "" });
              })
              .join(""),
        );
      } else parts.push(t("beat.why.rule", { op: ins.op, rule: rule() }));
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
    return i ? t("common.lineN", { line: i.line }) : hex(address);
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
  const expansion = events.map((e) => e.instruction.basic).join(t("common.semicolon"));
  const beats = [];
  const R = [...reads.values()],
    W = [...writes.values()];
  if (R.length)
    beats.push({
      eq: R.flatMap((a, i) => [
        i ? t("common.comma") : "",
        a.kind === "register" ? a.name : t("inspector.memoryCell", { address: hex(a.address) }),
        " = ",
        fresh(N(a.value, a.width || 4, a.kind === "memory" ? "bits" : "value")),
      ]),
      caption: t("beat.takeValues", { items: R.map((a) => a.name || hex(a.address)).join(t("common.listSep")) }),
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
          i ? t("common.comma") : "",
          a.kind === "register" ? a.name : t("inspector.memoryCell", { address: hex(a.address) }),
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
      caption: t("beat.line.result", { count: events.length }),
      lit: W.map((a) => ({ id: id(a), mode: "write" })),
      tokens: W.map((a) => ({
        from: "code",
        to: id(a),
        label: show(a.value),
        kind: "write",
        value: N(a.value, a.width || 4),
      })),
      why: t("beat.line.expansion", { expansion }),
    });
  const jumped =
    last.nextPC != null && last.nextPC !== last.instruction.address + 4;
  if (jumped || !beats.length)
    beats.push({
      eq: [`${t("beat.next")} `, ok(where(last.nextPC)), " ✓"],
      caption: jumped ? t("beat.jump") : t("beat.inOrder"),
      lit: [],
      tokens: [
        {
          from: "code",
          to: "next",
          label: jumped ? t("path.edge.jump") : "PC+4",
          kind: "flow",
        },
      ],
      why: beats.length ? "" : t("beat.line.expansionPlain", { expansion }),
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

// Grey decision text beside a line that branches or calls a service
// (2026-10-23 feedback): the values the condition compared and how it came
// out, or the service number, what it read and what it did. Recorded facts
// only, built from the line's operands and accesses, never per instruction.
const sourceCompare = {
  beq: "==",
  bne: "≠",
  blt: "<",
  bgt: ">",
  ble: "≤",
  bge: "≥",
  bltu: "<",
  bgtu: ">",
  bleu: "≤",
  bgeu: "≥",
  beqz: "== 0",
  bnez: "≠ 0",
};
export function lineDecision(
  events,
  { symbols = [], instructions = [], format = (v) => show(v) } = {},
) {
  const last = events?.at(-1),
    ins = last?.instruction;
  if (!ins || (ins.flow !== "branch" && ins.op !== "syscall")) return null;
  // The first value each register had on this line, before the line wrote it.
  const reads = new Map(),
    written = new Set();
  for (const e of events)
    for (const a of e.accesses || []) {
      if (a.kind !== "register") continue;
      if (!a.write && !written.has(a.name) && !reads.has(a.name))
        reads.set(a.name, a.value);
      if (a.write) written.add(a.name);
    }
  const val = (name) => (name === "$zero" ? 0 : reads.get(name));
  const reg = (t) =>
    /^\$\d+$/.test(t) ? "$" + registerNames[Number(t.slice(1))] : t;
  if (ins.op === "syscall") {
    const n = last.service ?? val("$v0");
    const [name, args = []] = services[n] || [t("beat.syscall.unsupportedName", { n })];
    const parts = [`$v0 = ${format(n, "$v0")} ${name}`];
    const shown = args
      .filter((r) => r !== "memory" && val(r) != null)
      .map((r) => `${r} = ${format(val(r), r)}`);
    if (shown.length) parts.push(" · " + shown.join(t("common.comma")));
    const results = [];
    if (last.output) {
      const out = [...last.output]
        .map((c) => escapeByte(c.charCodeAt(0)))
        .join("");
      // A character is a code looked up in the character table: say so for
      // service 11 (round-4 trial: why does 50 print "2"?).
      results.push(
        n === 11 && val("$a0") != null
          ? t("beat.syscall.printChar", { out, meaning: argumentMeaning(11, "$a0", val("$a0")) })
          : `${t("beat.output")} "${out.length > 16 ? out.slice(0, 15) + "…" : out}"`,
      );
    }
    for (const a of last.accesses || [])
      if (a.write && a.kind === "register")
        results.push(`${a.name} = ${format(a.value, a.name)}`);
    if (/^waiting/.test(last.status || "")) results.push(t("beat.waiting"));
    else if (n === 10 || n === 17) results.push(t("beat.programEnds"));
    if (results.length) parts.push(" → " + results.join(t("common.comma")));
    return parts.join("");
  }
  const op = ins.op,
    rs = "$" + registerNames[(ins.binary >>> 21) & 31],
    rt = "$" + registerNames[(ins.binary >>> 16) & 31];
  // The branch itself decides on the values it read (a pseudo branch first
  // computes them into $at).
  const own = (name) =>
    name === "$zero"
      ? 0
      : (last.accesses || []).find(
          (a) => a.kind === "register" && !a.write && a.name === name,
        )?.value;
  const x = own(rs),
    y = own(rt);
  const taken =
    op === "beq"
      ? x === y
      : op === "bne"
        ? x !== y
        : compareZero[op] && x != null
          ? compareZero[op][1](x)
          : null;
  if (taken == null) return null;
  const s = symbols.find((v) => v.address === ins.target && !v.data),
    targetLine = instructions.find((v) => v.address === ins.target);
  const target = s ? s.name : targetLine ? t("common.lineN", { line: targetLine.line }) : hex(ins.target);
  const always =
    (op === "beq" && rs === rt) ||
    (rs === "$zero" && /^(bgez|blez|bgezal)$/.test(op));
  if (always) return t("beat.line.goTo", { target });
  const [mn, ...args] = (events[0].instruction.source || "")
    .replace(/#.*/, "")
    .replace(/^\s*[\w.]+:/, "")
    .trim()
    .split(/[\s,]+/);
  const unsigned = /u$/.test(mn);
  const operand = (a) => {
    if (a == null) return undefined;
    if (a.startsWith("$")) {
      const v = val(reg(a));
      return v == null ? undefined : format(unsigned ? v >>> 0 : v, reg(a));
    }
    const n = Number(a);
    return Number.isFinite(n) ? format(unsigned ? n >>> 0 : n) : undefined;
  };
  let test = null;
  if (sourceCompare[mn]) {
    const a = operand(args[0]),
      b = /0$/.test(sourceCompare[mn]) && /z$/.test(mn) ? "" : operand(args[1]);
    if (a != null && b != null)
      test = `${a} ${sourceCompare[mn]}${b === "" ? "" : " " + b}`;
  } else if (compareZero[mn] && mn === op)
    test = `${format(x, rs)} ${compareZero[op][0]}`;
  const result = taken ? t("beat.line.goTo", { target }) : t("beat.line.next");
  if (test) return `${test} ${taken ? t("beat.holds") : t("beat.fails")} ${result}`;
  const listed = [...reads]
    .filter(([n]) => n !== "$zero" && n !== "$at")
    .map(([n, v]) => `${n} = ${format(v, n)}`);
  return [listed.join(t("common.comma")), result].filter(Boolean).join(" ");
}

// The general rule behind one line's template (classroom 2026-10-24): each
// register operand becomes a placeholder by its position in the source line
// ($a, $b, $c …) and each immediate operand becomes “立即数”, so
// `add $s0, $s0, $t0` (template `$s0 ← $s0 + $t0`) reads `$a ← $b + $c`.
// A register used twice takes the next unused position each time it appears.
export function genericTemplate(template, source = "") {
  const operands = source
    .replace(/#.*/, "")
    .trim()
    .replace(/^(?:[\w.$]+:\s*)*\S+\s*/, "")
    .split(/\s*,\s*/)
    .filter(Boolean)
    .map((t) => t.replace(/^-?\d+\((\$\w+)\)$/, "$1"));
  const letters = "abcdefgh",
    used = new Set();
  const placeholder = (token, kind) => {
    const i = operands.findIndex((o, n) => !used.has(n) && o === token);
    if (i < 0) return token;
    used.add(i);
    return kind === "reg" ? "$" + letters[i] : t("bits.immediate");
  };
  return text(Array.isArray(template) ? template : [template]).replace(
    /\$\w+|(?<![\w$.])-?\d+\b/g,
    (m) => (m.startsWith("$") ? placeholder(m, "reg") : placeholder(m, "imm")),
  );
}
