// Read-only number display (2026-10-22 trial, C2). One global choice of
// radix for registers, memory, addresses, inline values and the focus lens;
// source code is never rewritten. Every form carries its prefix so a value is
// never ambiguous, and a single printable byte also gets a faint character
// note: another way to read the same bits, not a claim about their meaning.

// What each choice shows; mechanism only, as in the glossary.
export const RADIX_HELP = {
  auto: "自动：看起来像地址的值（落在代码、数据或栈的范围内）用十六进制，其余用十进制。同一个值不会因为变大而换写法。",
  hex: "HEX：十六进制，前缀 0x。每一位表示 0–15（a–f 表示 10–15），两位正好是一个字节。",
  dec: "DEC：十进制，前缀 0d。普通数值按有符号数读（可以是负数）；原始字节和地址按无符号数读。",
  bin: "BIN：二进制，前缀 0b，每 4 位用 _ 分开；就是这些位本身。",
  ascii:
    "ASCII：把每个字节按字符编码表读成一个字符，例如 104 读作 h、48 读作 0；\\0、\\n、\\t 表示空字符、换行、制表。不像字符的值（例如 11）仍用十进制显示，并注明“不是可显示字符”。",
};

export const RADIXES = [
  ["auto", "自动"],
  ["hex", "HEX"],
  ["dec", "DEC"],
  ["bin", "BIN"],
  ["ascii", "ASCII"],
];

const printable = (b) => b >= 32 && b < 127;
// One escape vocabulary for bytes everywhere (\0 \n \t \xNN), as in ASCII mode.
export const escapeByte = (b) =>
  printable(b)
    ? String.fromCharCode(b)
    : b === 0
      ? "\\0"
      : b === 10
        ? "\\n"
        : b === 9
          ? "\\t"
          : "\\x" + b.toString(16).padStart(2, "0");

// kind: "value" (counts, data), "address", or "bits" (masks, raw patterns).
export function formatValue(
  n,
  { radix = "auto", width = 4, kind = "value" } = {},
) {
  const bits = 8 * width,
    unsigned = width < 4 ? (n & (2 ** bits - 1)) >>> 0 : n >>> 0,
    signed = width < 4 ? (unsigned << (32 - bits)) >> (32 - bits) : n | 0;
  const hex = "0x" + unsigned.toString(16).padStart(2 * width, "0");
  const bin = (all) => {
    const digits = unsigned.toString(2).padStart(bits, "0");
    const shown = all ? digits : digits.replace(/^(?:0000)+(?=.{4})/, "");
    return "0b" + shown.replace(/(.{4})(?=.)/g, "$1_");
  };
  // Raw bytes and masks are unsigned bit patterns, not signed operands.
  // Keep DEC consistent between memory cells, tooltips and the focus lens.
  const dec = "0d" + (kind === "value" ? signed : unsigned);
  const bytes = Array.from(
    { length: width },
    (_, i) => (unsigned >>> (8 * i)) & 255,
  );
  let shownBytes = bytes;
  while (shownBytes.length > 1 && shownBytes.at(-1) === 0)
    shownBytes = shownBytes.slice(0, -1);
  const ascii = "'" + shownBytes.map(escapeByte).join("") + "'";
  // Auto never switches an object's notation by size (round-2 trial: 898
  // became 0x00003820 after a shift). Values that look like addresses —
  // inside the program's code, data or stack segments — read in hex;
  // everything else, including masks and large counts, in decimal.
  // ASCII reads bytes as characters only when they are characters (round-3
  // trial: $v0 = 11 shown as '\x0b' was taken for a character); otherwise
  // the value falls back to decimal with a faint "not a character" note.
  const characters = shownBytes.every(
    (b) => b === 0 || b === 9 || b === 10 || printable(b),
  );
  const fallback = radix === "ascii" && !characters;
  const mode =
    radix === "auto"
      ? kind === "address" || (width === 4 && looksLikeAddress(unsigned))
        ? "hex"
        : "dec"
      : fallback
        ? "dec"
        : radix;
  const text = { hex, dec, bin: bin(false), ascii }[mode] ?? hex;
  const note = fallback
    ? "不是可显示字符"
    : mode !== "ascii" && width === 1 && printable(unsigned)
      ? `'${String.fromCharCode(unsigned)}'`
      : "";
  return { text, note, full: { hex, dec, bin: bin(true), ascii }[mode] ?? hex };
}

// MARS's default layout: text from 0x00400000, data/heap from 0x10000000,
// stack below 0x80000000.
export function looksLikeAddress(u) {
  return u >= 0x00400000 && u < 0x80000000;
}

// Registers whose contents are conventionally addresses.
export const addressRegisters = new Set(["$sp", "$fp", "$gp", "$ra", "pc"]);
