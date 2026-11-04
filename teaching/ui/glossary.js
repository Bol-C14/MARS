// Terms the IDE itself uses, with the mechanism they name (2026-10-22 trial,
// C1). Definitions say what a thing is, never what a program uses it for —
// intent comes from the program's own comments. Teachers may edit this list:
// each term's name and definition are in the catalogs (gloss.<id>.term/.def).
import { escapeHTML as esc } from "./model.js";
import { t, localized } from "./i18n/index.js";

// Each definition ends with a small generic example (round-3 trial: bare
// definitions such as "基址：计算地址时用作起点的寄存器值" were still opaque).
// i18n-keys: gloss.*
const TERMS = ["byte", "address", "effectiveAddress", "pseudo", "machineInstruction", "delayedBranch", "delaySlot", "signExtend", "zeroExtend", "littleEndian", "twosComplement", "carry", "nul", "immediate", "base", "offset", "register", "syscall", "overflow", "alignment", "returnAddress", "pc", "charEncoding", "ascii", "hex", "rs", "rt", "rd"];
export const glossary = localized(() =>
  Object.fromEntries(TERMS.map((id) => [t(`gloss.${id}.term`), t(`gloss.${id}.def`)])),
);

// The terms as written in the current language: whole words where a term is
// made of letters (so "base" does not mark "database"), in any case and
// with a plural ending.
const matcher = localized(() => {
  const terms = Object.keys(glossary).sort((a, b) => b.length - a.length);
  const lower = new Map(terms.map((term) => [term.toLowerCase(), term]));
  const re = new RegExp(
    terms
      .map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .map((term) => (/^[\w' -]+$/.test(term) ? `\\b${term}(?:e?s)?\\b` : term))
      .join("|"),
    "gi",
  );
  const find = (text) => {
    const l = text.toLowerCase();
    return lower.get(l) ?? lower.get(l.replace(/e?s$/, "")) ?? lower.get(l.replace(/s$/, ""));
  };
  return { re, find };
});

// Escaped HTML with the first use of each term marked; hover shows the definition.
export function glossify(text) {
  const seen = new Set();
  return esc(text).replace(matcher.re, (found) => {
    const term = matcher.find(found);
    if (!term || seen.has(term)) return found;
    seen.add(term);
    return `<abbr class="term" title="${esc(glossary[term])}">${found}</abbr>`;
  });
}

// Definitions of the terms a text uses, for places that cannot be hovered
// themselves (the editor tooltip follows the pointer).
export function termsIn(text) {
  return [...new Set((String(text).match(matcher.re) || []).map(matcher.find).filter(Boolean))].map((term) => [
    term,
    glossary[term],
  ]);
}
