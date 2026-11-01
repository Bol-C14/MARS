// Checks while the student types. A short pause checks the changed lines; a
// longer one checks the whole assembly scope. The checker lives apart from
// the debug session, so a check can never disturb a paused program. Each kind
// has one request in flight and only the newest waiting; an answer about text
// that has since changed is dropped.
const MAX_LINES = 200;
export function liveCheck({ post, current, scope, ready, held, showLines, showScope, lineDelay = 600, fullDelay = 3000 }) {
  let enabled = true, version = 0, lineTimer, fullTimer, changed = null, checked = "";
  const flying = {}, waiting = {};
  async function send(kind, body, accept, asked = version) {
    if (!enabled || asked !== version) return;
    if (flying[kind]) { waiting[kind] = [body, accept, asked]; return; }
    flying[kind] = true;
    // null: this deployment has no checker. undefined: this one try failed.
    const reply = await post({ protocol: 1, id: asked, ...body }).catch(() => undefined);
    flying[kind] = false;
    if (reply === null) enabled = false;
    else if (reply?.status === "ok" && asked === version) accept(reply);
    const next = waiting[kind];
    delete waiting[kind];
    if (next) send(kind, ...next);
  }
  function checkLines() {
    const { file, doc } = current();
    if (!changed || !file) return;
    const first = doc.lineAt(Math.min(changed.from, doc.length)).number,
      last = Math.min(doc.lineAt(Math.min(changed.to, doc.length)).number, first + MAX_LINES);
    changed = null;
    const lines = Array.from({ length: last - first + 1 }, (_, i) => first + i);
    send("line", { command: "line", file, text: doc.toString(), lines }, (r) => showLines(lines, r.diagnostics));
  }
  function checkScope() {
    if (!ready()) { fullTimer = setTimeout(checkScope, 1000); return; }
    // Basic mistakes first: they would only come back as follow-on errors.
    const s = scope();
    if (held() || !s) return;
    const key = JSON.stringify(s);
    if (key === checked) return;
    send("full", { command: "full", ...s }, (r) => { checked = key; showScope(r.diagnostics, s.files); });
  }
  return {
    edited(changes) {
      version++;
      const mapped = changed && { from: changes.mapPos(changed.from, -1), to: changes.mapPos(changed.to, 1) };
      changed = mapped;
      changes.iterChangedRanges((_a, _b, from, to) => {
        changed = { from: Math.min(changed?.from ?? from, from), to: Math.max(changed?.to ?? to, to) };
      });
      clearTimeout(lineTimer);
      clearTimeout(fullTimer);
      lineTimer = setTimeout(checkLines, lineDelay);
      fullTimer = setTimeout(checkScope, fullDelay);
    },
    // The file, the project or the loaded program changed: what is on its way
    // no longer applies.
    reset() {
      version++;
      changed = null;
      clearTimeout(lineTimer);
      clearTimeout(fullTimer);
    },
    enabled: () => enabled,
  };
}
