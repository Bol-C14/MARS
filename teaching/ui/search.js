// Quick open (DESIGN §3.8): one picker for files, labels, lines, addresses
// and commands, using VS Code's prefixes. Pure: returns ranked items.

// Ordered-subsequence match; prefixes and contiguous runs rank higher.
export function fuzzy(query, text) {
  if (!query) return 0;
  const q = query.toLowerCase(),
    t = text.toLowerCase();
  if (t.startsWith(q)) return 1000 - t.length;
  const at = t.indexOf(q);
  if (at >= 0) return 800 - at - t.length;
  let score = 0,
    j = 0,
    run = 0;
  for (const c of q) {
    const k = t.indexOf(c, j);
    if (k < 0) return -1;
    run = k === j ? run + 1 : 0;
    score += 10 + run * 5 - (k - j);
    j = k + 1;
  }
  return score;
}

const LABEL = /^\s*([A-Za-z_.$][\w.$]*)\s*:/;

// Labels defined in one file, in source order.
export function outline(files, file, symbols = []) {
  const out = [];
  (files[file] || "").split("\n").forEach((text, i) => {
    const m = text.split("#")[0].match(LABEL);
    if (!m) return;
    const s = symbols.find(
      (x) => x.name === m[1] && (!x.file || x.file === file),
    );
    out.push({
      kind: "symbol",
      label: m[1],
      detail: `${s?.data ? "数据" : "代码"} · 第 ${i + 1} 行${s ? " · 0x" + (s.address >>> 0).toString(16).padStart(8, "0") : ""}`,
      file,
      line: i + 1,
      symbol: s,
    });
  });
  return out;
}

const rank = (items, query, key = (x) => x.label) =>
  items
    .map((x) => ({ x, score: fuzzy(query, key(x)) }))
    .filter((r) => r.score >= 0)
    .sort((a, b) => b.score - a.score)
    .map((r) => r.x);

export function quickOpenItems(
  input,
  { files = {}, symbols = [], activeFile = "", commands = [], limit = 50 } = {},
) {
  const query = input.trim();
  if (query.startsWith(">"))
    return rank(
      commands.map((c, i) => ({
        kind: "command",
        label: c.label,
        detail: c.keys || "",
        index: i,
      })),
      query.slice(1).trim(),
    ).slice(0, limit);
  if (query.startsWith("@"))
    return rank(
      outline(files, activeFile, symbols),
      query.slice(1).trim(),
    ).slice(0, limit);
  const line = query.match(/^(?:(.+?))?:(\d+)$/);
  if (line) {
    const file = line[1]
      ? Object.keys(files).find(
          (f) => f === line[1] || f.endsWith("/" + line[1]),
        )
      : activeFile;
    const n = Number(line[2]);
    const total = file ? files[file].split("\n").length : 0;
    return file && n >= 1 && n <= total
      ? [
          {
            kind: "line",
            label: `${file}:${n}`,
            detail: files[file].split("\n")[n - 1].trim(),
            file,
            line: n,
          },
        ]
      : [];
  }
  if (/^0x[0-9a-f]+$/i.test(query)) {
    const address = Number.parseInt(query, 16) | 0;
    const named = symbols.find((s) => s.address === address);
    return [
      {
        kind: "address",
        label: "0x" + (address >>> 0).toString(16).padStart(8, "0"),
        detail: named ? named.name : "地址",
        address,
      },
    ];
  }
  const fileItems = Object.keys(files).map((f) => ({
    kind: "file",
    label: f,
    detail: "文件",
    file: f,
  }));
  const seen = new Set();
  const symbolItems = Object.keys(files)
    .flatMap((f) => outline(files, f, symbols))
    .filter((x) => !seen.has(x.label + x.file) && seen.add(x.label + x.file))
    .map((x) => ({ ...x, detail: `${x.file} · ${x.detail}` }));
  if (!query) return [...fileItems, ...symbolItems].slice(0, limit);
  return rank([...fileItems, ...symbolItems], query).slice(0, limit);
}
