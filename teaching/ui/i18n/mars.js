// MARS reports assembly and runtime errors in English (classroom 2026-11-03).
// Each known message has a key under mars.*: English repeats MARS's own words,
// other languages translate them. Messages not listed here are shown as MARS
// wrote them. The original text stays in the program state (scope hints read
// it); only what is shown goes through marsText.
import { t } from "./index.js";

// i18n-keys: mars.*
// [pattern, key, names of the captured groups]
const MESSAGES = [
  [/^"(.+)" is not a recognized operator$/, "mars.unknownOperator", ["name"]],
  [/^"(.+)": Too few or incorrectly formatted operands\. Expected: (.+)$/, "mars.tooFew", ["op", "expected"]],
  [/^"(.+)": Too many or incorrectly formatted operands\. Expected: (.+)$/, "mars.tooMany", ["op", "expected"]],
  [/^"(.+)": operand is of incorrect type$/, "mars.operandType", ["operand"]],
  [/^"(.+)": operand is out of range$/, "mars.operandRange", ["operand"]],
  [/^Symbol "(.+)" not found in symbol table\.$/, "mars.symbolNotFound", ["name"]],
  [/^label "(.+)" already defined$/, "mars.labelDefined", ["name"]],
  [/^"(.+)" already defined as global in a different file\.$/, "mars.globalDefined", ["name"]],
  [/^"(.+)" declared global label but not defined\.$/, "mars.globalUndefined", ["name"]],
  [/^"(.+)" is not a valid character string$/, "mars.badString", ["text"]],
  [/^MARS does not recognize the (\S+) directive\.\s+Ignored\.$/, "mars.unknownDirective", ["directive"]],
  [/^"(.+)" requires a non-negative integer$/, "mars.nonNegative", ["directive"]],
  [/^Macro started but not ended \(no \.end_macro directive\)$/, "mars.macroOpen", []],
  [/^[\s\S]*\nInvalid language element: (.+)$/, "mars.invalidElement", ["text"]],
  [/^unsupported syscall (\d+)$/, "mars.unsupportedSyscall", ["n"]],
];
// The reason after "Runtime exception at 0x…:".
const REASONS = [
  [/^arithmetic overflow$/, "mars.reason.overflow", []],
  [/^fetch address not aligned on word boundary (\S+)$/, "mars.reason.fetchAlign", ["address"]],
  [/^store address not aligned on word boundary (\S+)$/, "mars.reason.storeAlign", ["address"]],
  [/^address out of range (\S+)$/, "mars.reason.range", ["address"]],
];

function match(table, text) {
  for (const [re, key, names] of table) {
    const m = re.exec(text);
    if (m) return t(key, Object.fromEntries(names.map((n, i) => [n, m[i + 1]])));
  }
  return null;
}

/** A MARS message in the interface language; unknown ones stay as written. */
export function marsText(message) {
  const text = String(message ?? "").trim();
  // "Error in /tmp/…/main.s line 3: Runtime exception at 0x…: reason" — the
  // temporary path means nothing to a student.
  const runtime = /^Error in .*? line (\d+): Runtime exception at (0x[0-9a-f]+): ([\s\S]*)$/i.exec(text);
  if (runtime) {
    const reason = runtime[3].trim();
    return t("mars.runtime", { line: runtime[1], address: runtime[2], reason: match(REASONS, reason) ?? reason });
  }
  return match(MESSAGES, text) ?? text;
}
