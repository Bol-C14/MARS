// Read-only number display (2026-10-22 trial, C2). One global choice of
// radix for registers, memory, addresses, inline values and the focus lens;
// source code is never rewritten. Every form carries its prefix so a value is
// never ambiguous, and a single printable byte also gets a faint character
// note: another way to read the same bits, not a claim about their meaning.

export const RADIXES = [
  ["auto", "自动"],
  ["hex", "HEX"],
  ["dec", "DEC"],
  ["bin", "BIN"],
  ["ascii", "ASCII"],
];

const printable = (b) => b >= 32 && b < 127;
const escapeByte = (b) =>
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
  const mode =
    radix === "auto"
      ? kind === "value" && Math.abs(signed) < 10000
        ? "dec"
        : "hex"
      : radix;
  const text = { hex, dec, bin: bin(false), ascii }[mode] ?? hex;
  const note =
    mode !== "ascii" && width === 1 && printable(unsigned)
      ? `'${String.fromCharCode(unsigned)}'`
      : "";
  return { text, note, full: { hex, dec, bin: bin(true), ascii }[mode] ?? hex };
}

// Registers whose contents are conventionally addresses.
export const addressRegisters = new Set(["$sp", "$fp", "$gp", "$ra", "pc"]);
