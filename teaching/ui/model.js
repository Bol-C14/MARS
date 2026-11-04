import { t, localized } from "./i18n/index.js";
export const hex = (n) => "0x" + (n >>> 0).toString(16).padStart(8, "0");
export const escapeHTML = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
export const registerNames = [
  "zero",
  "at",
  "v0",
  "v1",
  "a0",
  "a1",
  "a2",
  "a3",
  "t0",
  "t1",
  "t2",
  "t3",
  "t4",
  "t5",
  "t6",
  "t7",
  "s0",
  "s1",
  "s2",
  "s3",
  "s4",
  "s5",
  "s6",
  "s7",
  "t8",
  "t9",
  "k0",
  "k1",
  "gp",
  "sp",
  "fp",
  "ra",
];
export function canonicalReg(token) {
  if (/^\$\d+$/.test(token)) return "$" + registerNames[Number(token.slice(1))];
  return token === "$s8" ? "$fp" : token;
}
export const services = localized(() => ({
  1: [t("service.1"), ["$a0"], []],
  2: [t("service.2"), ["$f12"], []],
  3: [t("service.3"), ["$f12", "$f13"], []],
  4: [t("service.4"), ["$a0"], []],
  5: [t("service.5"), [], ["$v0"]],
  6: [t("service.6"), [], ["$f0"]],
  7: [t("service.7"), [], ["$f0", "$f1"]],
  8: [t("service.8"), ["$a0", "$a1"], ["memory"]],
  9: [t("service.9"), ["$a0"], ["$v0"]],
  10: [t("service.10"), [], []],
  11: [t("service.11"), ["$a0"], []],
  12: [t("service.12"), [], ["$v0"]],
  13: [t("service.13"), ["$a0", "$a1", "$a2"], ["$v0"]],
  14: [t("service.14"), ["$a0", "$a1", "$a2"], ["memory", "$v0"]],
  15: [t("service.15"), ["$a0", "$a1", "$a2"], ["$v0"]],
  16: [t("service.16"), ["$a0"], []],
  17: [t("service.17"), ["$a0"], []],
  34: [t("service.34"), ["$a0"], []],
  35: [t("service.35"), ["$a0"], []],
  36: [t("service.36"), ["$a0"], []],
}));
export const explanations = localized(() => ({
  addiu:
    t("explain.addiu"),
  addi: t("explain.addi"),
  addu: t("explain.addu"),
  add: t("explain.add"),
  subu: t("explain.subu"),
  lbu: t("explain.lbu"),
  lb: t("explain.lb"),
  lw: t("explain.lw"),
  sw: t("explain.sw"),
  sb: t("explain.sb"),
  srl: t("explain.srl"),
  sll: t("explain.sll"),
  slti: t("explain.slti"),
  beq: t("explain.beq"),
  bne: t("explain.bne"),
  jal: t("explain.jal"),
  jr: t("explain.jr"),
  syscall: t("explain.syscall"),
  li: t("explain.li"),
  la: t("explain.la"),
  move: t("explain.move"),
  nop: t("explain.nop"),
  lui: t("explain.lui"),
  ori: t("explain.ori"),
}));
export function role(name) {
  let n = registerNames.indexOf(name.replace("$", ""));
  return n === 0
    ? t("role.zero")
    : n === 1
      ? t("role.at")
      : n === 2 || n === 3
        ? t("role.v")
        : n >= 4 && n <= 7
          ? t("role.a")
          : n >= 16 && n <= 23
            ? t("role.s")
            : n === 29
              ? t("role.sp")
              : n === 31
                ? t("role.ra")
                : n === 28
                  ? t("role.gp")
                  : n === 30
                    ? t("role.fp")
                    : n === 26 || n === 27
                      ? t("role.k")
                      : t("role.t");
}
export function references(files, token) {
  let out = [];
  for (let [file, text] of Object.entries(files))
    text.split("\n").forEach((line, i) => {
      let code = line.split("#")[0],
        tokens = code.match(/\$\w+|[\w.]+/g) || [];
      if (!tokens.some((t) => canonicalReg(t) === canonicalReg(token))) return;
      let op = tokens[0],
        regs = tokens.filter((t) => t.startsWith("$")),
        r = canonicalReg(token),
        k = t("refs.kind.use");
      if (token.startsWith("$")) {
        let occurrences = regs.map(canonicalReg),
          first = occurrences[0] === r,
          read = occurrences.slice(1).includes(r);
        if (/^(sw|sb|sh|b\w*|jr|multu?|divu?|mthi|mtlo)$/.test(op)) k = t("refs.kind.read");
        else if (
          /^(li|la|move|l[bhw]u?|sll|srl|sra|add\w*|sub\w*|and\w*|or\w*|xor\w*|nor|slt\w*|mfhi|mflo)$/.test(
            op,
          )
        )
          k = first ? (read ? t("refs.kind.readWrite") : t("refs.kind.write")) : t("refs.kind.read");
        else k = t("refs.kind.operand");
      } else if (
        new RegExp(
          "^\\s*" + token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*:",
        ).test(code)
      )
        k = t("refs.kind.definition");
      else if (/^(b\w*|j|jal)$/.test(op)) k = t("refs.kind.transfer");
      out.push({ file, line: i + 1, text: line, type: k });
    });
  return out;
}
export function buildCFG(instructions, delay = false) {
  let by = new Map(instructions.map((i) => [i.address, i])),
    leaders = new Set();
  if (instructions[0]) leaders.add(instructions[0].address);
  for (let i of instructions)
    if (i.flow !== "next") {
      if (by.has(i.target)) leaders.add(i.target);
      let next = i.address + (delay ? 8 : 4);
      if (by.has(next)) leaders.add(next);
    }
  let blocks = [],
    current;
  for (let i of instructions) {
    if (!current || leaders.has(i.address) || i.address !== current.end + 4) {
      current = {
        id: i.address,
        start: i.address,
        end: i.address,
        instructions: [],
        edges: [],
      };
      blocks.push(current);
    }
    current.instructions.push(i);
    current.end = i.address;
  }
  let owner = new Map();
  for (let b of blocks)
    for (let i of b.instructions) owner.set(i.address, b.id);
  for (let b of blocks) {
    let terminal =
      [...b.instructions].reverse().find((i) => i.flow !== "next") ||
      b.instructions.at(-1);
    let add = (address, label) => {
      if (owner.has(address))
        b.edges.push({ target: owner.get(address), label });
    };
    if (terminal.flow === "branch") {
      add(terminal.target, t("path.edge.taken"));
      add(terminal.address + (delay ? 8 : 4), t("path.edge.fallthrough"));
    } else if (terminal.flow === "jump") add(terminal.target, t("path.edge.jump"));
    else if (terminal.flow === "call") {
      add(terminal.target, t("path.edge.call"));
      add(terminal.address + (delay ? 8 : 4), t("cfg.edge.afterReturn"));
    } else if (terminal.flow === "indirect")
      b.edges.push({ target: null, label: t("cfg.edge.runtime") });
    else add(b.end + 4, t("path.edge.next"));
  }
  return blocks;
}

// Code and comment of one source line; "#" inside a string is not a comment.
export function splitComment(line) {
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === "#")
      return {
        code: line.slice(0, i).trim(),
        comment: line.slice(i + 1).trim(),
      };
  }
  return { code: line.trim(), comment: "" };
}

// Machine statements as MARS prints them use register numbers ($2); show the
// names students see everywhere else ($v0) (trial C3).
export function nameRegisters(text) {
  return String(text ?? "").replace(/\$(\d+)\b/g, (m, n) =>
    Number(n) < 32 ? "$" + registerNames[Number(n)] : m,
  );
}

// MARS documents each instruction with example operands ("beqz $t1,label").
// Substitute the operands of the line being read, by position, in one pass
// (round-3 trial: "if $t1 is equal to zero" on a line that tests $a1).
export function withOperands(description, example, line) {
  const operands = (text, op) =>
    text
      .trim()
      .replace(/^[A-Za-z_.$][\w.$]*\s*:\s*/, "")
      .slice(op.length)
      .split(/[\s,()]+/)
      .filter(Boolean);
  const op = (example || "").trim().split(/\s+/)[0] || "";
  const code = splitComment(line || "").code;
  if (!op || !code.replace(/^[A-Za-z_.$][\w.$]*\s*:\s*/, "").startsWith(op))
    return { text: description, substituted: false };
  const from = operands(example, op),
    to = operands(code, op);
  if (!from.length || from.length !== to.length)
    return { text: description, substituted: false };
  const map = new Map(from.map((f, i) => [f, to[i]]));
  const pattern = new RegExp(
    [...map.keys()]
      .sort((a, b) => b.length - a.length)
      .map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(?![\\w])")
      .join("|"),
    "g",
  );
  return {
    text: description.replace(pattern, (m) => map.get(m) ?? m),
    substituted: true,
  };
}
