// The memory panel's model (classroom 2026-11-04): where an address typed by
// a student points, which data symbol owns which bytes, how a window of
// bytes is laid out as bytes, words or text, and where an address sits on
// the memory bar. Pure: the IDE draws what these return.

const NUMBER = /^(?:0x[\da-f]+|\d+)$/i;

/**
 * An address from what a student types: a number, a label or a register,
 * optionally plus or minus a constant ("scores+8", "$sp-4"), or an offset on
 * a register as in code ("4($sp)"). null when it names nothing known.
 */
export function parseAddress(text, { symbols = [], register = () => undefined } = {}) {
  const s = String(text).trim();
  let m = /^(-?(?:0x[\da-f]+|\d+))?\s*\(\s*(\$\w+)\s*\)$/i.exec(s);
  if (m) {
    const base = register(m[2]);
    return base == null ? null : (base + (m[1] ? Number(m[1]) : 0)) | 0;
  }
  m = /^(\$?[A-Za-z_.][\w.]*|0x[\da-f]+|\d+)\s*(?:([+-])\s*(0x[\da-f]+|\d+))?$/i.exec(s);
  if (!m) return null;
  const base = NUMBER.test(m[1])
    ? Number(m[1])
    : m[1].startsWith("$")
      ? register(m[1])
      : symbols.find((x) => x.name === m[1])?.address;
  if (base == null || !Number.isFinite(base)) return null;
  const offset = m[3] ? Number(m[3]) : 0;
  return (base + (m[2] === "-" ? -offset : offset)) | 0;
}

// Bytes a data directive takes, from its operands as written.
function directiveSize(directive, operands) {
  const items = operands.split(",").filter((x) => x.trim()).reduce((sum, item) => {
    const repeat = /:\s*(0x[\da-f]+|\d+)\s*$/i.exec(item);
    return sum + (repeat ? Number(repeat[1]) : 1);
  }, 0);
  const text = (/"((?:[^"\\]|\\.)*)"/.exec(operands)?.[1] ?? "").replace(/\\./g, "x");
  switch (directive) {
    case ".word": case ".float": return 4 * items;
    case ".double": return 8 * items;
    case ".half": return 2 * items;
    case ".byte": return items;
    case ".space": return Math.max(0, parseInt(operands, 0) || Number(operands.trim()) || 0);
    case ".ascii": return text.length;
    case ".asciiz": return text.length + 1;
    default: return 0;
  }
}

/**
 * Data labels in address order with how much each takes and how its
 * contents read best: words for .word, text for .ascii/.asciiz, bytes
 * otherwise. The size is the gap to the next label, or for the last one
 * what its directive declares.
 */
export function dataSymbols(symbols = [], sources = {}) {
  const list = symbols
    .filter((s) => s.data)
    .map((s) => {
      // A .globl label has no file of its own: look in every file.
      const defines = new RegExp(`^\\s*${s.name.replace(/[.$]/g, "\\$&")}\\s*:`);
      const text =
        [sources[s.file], ...Object.values(sources)].find((t) => t && t.split("\n").some((l) => defines.test(l))) || "";
      const lines = text.split("\n");
      let directive = "", operands = "";
      const at = lines.findIndex((l) => defines.test(l));
      for (let i = at; at >= 0 && i < lines.length && i < at + 4; i++) {
        const code = (i === at ? lines[i].replace(/^[^:]*:/, "") : lines[i]).replace(/#.*$/, "").trim();
        const d = /^(\.\w+)\s*(.*)$/.exec(code);
        if (d && d[1] !== ".align" && d[1] !== ".globl") {
          [directive, operands] = [d[1], d[2]];
          break;
        }
        if (code && !d) break;
      }
      return { name: s.name, address: s.address >>> 0, directive, size: directiveSize(directive, operands) };
    })
    .sort((a, b) => a.address - b.address);
  list.forEach((s, i) => {
    const next = list[i + 1];
    if (next) s.size = Math.min(s.size || Infinity, next.address - s.address);
    s.size = Math.max(1, s.size || 4);
    s.end = s.address + s.size;
    s.view = s.directive === ".word" ? "words" : /^\.ascii/.test(s.directive) ? "text" : "bytes";
  });
  return list;
}

/**
 * Rows for a window of memory ([{address, value}], consecutive): a label row
 * where a data symbol starts, then cells of one byte (bytes, text) or four
 * (words, when aligned and whole). Rows start at multiples of 8 bytes (16
 * for text) and at every symbol start.
 */
export function memoryRows(memory = [], symbols = [], view = "words") {
  const starts = new Map(symbols.map((s) => [s.address >>> 0, s]));
  const perRow = view === "text" ? 16 : 8;
  const rows = [];
  let row = null;
  for (let i = 0; i < memory.length; ) {
    const address = memory[i].address >>> 0;
    const symbol = starts.get(address);
    if (symbol) {
      rows.push({ label: symbol });
      row = null;
    }
    // Rows start on a multiple of their width, as in a hex dump, so a
    // label that starts mid-row gets a short first row.
    if (!row || address % perRow === 0) {
      row = { address, cells: [], bytes: 0 };
      rows.push(row);
    }
    const word =
      view === "words" &&
      address % 4 === 0 &&
      i + 4 <= memory.length &&
      address % perRow <= perRow - 4 &&
      ![1, 2, 3].some((k) => starts.has(address + k));
    const width = word ? 4 : 1;
    const bytes = memory.slice(i, i + width);
    row.cells.push({ address, width, bytes: bytes.map((b) => b.value) });
    row.bytes += width;
    i += width;
  }
  return rows;
}

/** The little-endian value of a word cell, or null if a byte is unreadable. */
export const wordValue = (bytes) =>
  bytes.some((b) => b == null) ? null : (bytes[0] | (bytes[1] << 8) | (bytes[2] << 16) | (bytes[3] << 24)) | 0;

/**
 * The memory bar, top to bottom in the list's own direction (lower
 * addresses higher up): code, data, heap, free space, stack. Each segment
 * gets a fixed share of the height (memory is far too sparse to draw to
 * scale). Its band is every address that belongs to it; its range, the part
 * in use, takes most of the share, and the rest of the band the remainder,
 * so every address from code to the stack top has a place.
 */
export function memoryBar({ layout, sp, dataEnd, textEnd }) {
  if (!layout) return [];
  const text = layout.text >>> 0,
    data = layout.data >>> 0,
    heap = layout.heap >>> 0,
    stackTop = (layout.stack >>> 0) + 4,
    heapTop = Math.max(layout.heapTop >>> 0, heap + 64),
    stackLow = Math.min(sp >>> 0, stackTop - 64);
  return [
    { id: "text", share: 0.22, from: text, to: Math.max(textEnd >>> 0, text + 4), end: data },
    { id: "data", share: 0.3, from: data, to: Math.max(dataEnd >>> 0, data + 16), end: heap },
    { id: "heap", share: 0.14, from: heap, to: heapTop, end: heapTop },
    { id: "free", share: 0.1, from: heapTop, to: stackLow, end: stackLow },
    // Above the stack's start, up to the kernel at 0x80000000.
    { id: "stack", share: 0.24, from: stackLow, to: stackTop, end: 0x80000000 },
  ];
}

/**
 * Where an address falls on the bar, from 0 (top) to 1 (bottom), and in which
 * segment; null outside the program's space. Higher addresses sit lower.
 */
export function barPosition(segments, address) {
  const a = address >>> 0;
  let top = 0;
  for (const s of segments) {
    if (a >= s.from && a < Math.max(s.end, s.to)) {
      const used = s.end > s.to ? 0.85 : 1;
      const within =
        a < s.to
          ? ((a - s.from) / Math.max(1, s.to - s.from)) * used
          : used + ((a - s.to) / Math.max(1, s.end - s.to)) * (1 - used);
      return { segment: s.id, y: top + Math.min(within, 0.999) * s.share };
    }
    top += s.share;
  }
  return null;
}
