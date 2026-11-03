// Checks while the student types. A short pause checks the changed lines; a
// longer one checks the whole assembly scope. The checker lives apart from
// the debug session, so a check can never disturb a paused program. Each kind
// has one request in flight and only the newest waiting; an answer about text
// that has since changed is dropped.
const MAX_LINES = 200;
export function liveCheck({ post, current, scope, ready, held, showLines, showScope, lineDelay = 600, fullDelay = 3000, retryDelay = 1000 }) {
  let enabled = true, version = 0, lineTimer, fullTimer, changed = null, checked = "", fullDue = 0, forceFull = false, cached = null;
  const flying = {}, waiting = {};
  async function send(kind, body, accept, asked = version) {
    if (!enabled || asked !== version) return;
    if (flying[kind]) { waiting[kind] = [body, accept, asked]; return; }
    flying[kind] = true;
    // null: this deployment has no checker. undefined: this one try failed.
    const reply = await post({ protocol: 1, id: asked, ...body }).catch(() => undefined);
    flying[kind] = false;
    if (reply === null) {
      enabled = false;
      clearTimeout(lineTimer); clearTimeout(fullTimer);
    } else if (asked === version) {
      if (reply?.status === "ok") accept(reply);
      else if (reply?.status === "undetermined" && kind === "line") accept({unavailable: true});
      else if (!reply) {
        if (kind === "line") lineTimer = setTimeout(checkLines, retryDelay);
        else fullTimer = setTimeout(checkScope, retryDelay);
      }
    }
    const next = waiting[kind];
    delete waiting[kind];
    if (next) send(kind, ...next);
  }
  function checkLines() {
    if (!enabled) return;
    if (!ready()) { lineTimer = setTimeout(checkLines, retryDelay); return; }
    const { file, doc } = current();
    if (!changed || !file) return;
    const first = doc.lineAt(Math.min(changed.from, doc.length)).number,
      last = Math.min(doc.lineAt(Math.min(changed.to, doc.length)).number, first + MAX_LINES);
    const lines = Array.from({ length: last - first + 1 }, (_, i) => first + i);
    send("line", { command: "line", file, text: doc.toString(), lines }, (r) => {
      // Only a reply for the current text retires these changed lines.
      // An older in-flight request may cover edits on a different line.
      if (changed && doc.lineAt(Math.min(changed.to, doc.length)).number > last) {
        changed = {from: doc.line(last + 1).from, to: changed.to};
        lineTimer = setTimeout(checkLines, 0);
      } else changed = null;
      if (r.unavailable === true) forceFull = true;
      else showLines(lines, r.diagnostics);
      if (Date.now() >= fullDue) {
        clearTimeout(fullTimer);
        fullTimer = setTimeout(checkScope, 0);
      }
    });
  }
  function checkScope() {
    if (!enabled) return;
    if (!ready()) { fullTimer = setTimeout(checkScope, retryDelay); return; }
    // The current line reply will resume the full check when it is ready.
    if (changed || flying.line || waiting.line) return;
    // Basic mistakes first: they would only come back as follow-on errors.
    const s = scope();
    if ((!forceFull && held()) || !s) return;
    const key = JSON.stringify(s);
    if (key === checked) { if (cached) showScope(cached, s.files); return; }
    send("full", { command: "full", ...s }, (r) => { checked = key; cached = r.diagnostics; forceFull = false; showScope(r.diagnostics, s.files); });
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
      fullDue = Date.now() + fullDelay;
      fullTimer = setTimeout(checkScope, fullDelay);
    },
    // The file, the project or the loaded program changed: what is on its way
    // no longer applies.
    reset() {
      version++;
      changed = null;
      checked = "";
      cached = null;
      forceFull = false;
      delete waiting.line; delete waiting.full;
      clearTimeout(lineTimer);
      clearTimeout(fullTimer);
    },
    enabled: () => enabled,
  };
}
