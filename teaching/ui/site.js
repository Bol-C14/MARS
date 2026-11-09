// The public static edition's own parts (2026-11-08): anonymous usage events,
// and the feedback and report-a-problem flow. The site speaks only as
// MARS Trace: no personal name or account. Only the browser build turns
// these on; the classroom server build is unchanged.
//
// Settings live in site/config.json. Until an id is filled in, analytics is
// off and feedback falls back to a GitHub issue, then to e-mail. No cookies, no personal
// data: events carry only the interface language, and a student's program
// goes with a report only when they tick the box for it.
import config from "../site/config.json" with { type: "json" };
import { t, language } from "./i18n/index.js";
import { escapeHTML as esc } from "./model.js";

export const BUILD = typeof __MARS_BUILD__ !== "undefined" ? __MARS_BUILD__ : "dev";
export const site = config;

let enabled = false;
// Events from before the tracker has loaded wait here (a linked example
// opens before it is ready).
let waiting = [];
let lastError = "";
const once = new Set();
const PROGRAM_LIMIT = 8000;

function loadScript(src, attrs = {}) {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.defer = true;
    for (const [k, v] of Object.entries(attrs)) s.setAttribute(k, v);
    s.onload = resolve;
    s.onerror = reject;
    document.head.append(s);
  });
}

// Local copies (development, tests) never count, unless a test asks to
// watch what would be sent; elsewhere the tracker itself counts only the
// real site (data-domains), so a copy on another host stays out too.
function testing() {
  try {
    return localStorage.getItem("mars-trace:analytics-test") === "1";
  } catch {
    return false;
  }
}
export function counted() {
  return !/^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname) || testing();
}

/** Start analytics when the build is the public one and an id is set. */
export function startSite(on) {
  enabled = Boolean(on);
  if (!enabled) return;
  document.documentElement.dataset.site = "public";
  if (config.umami.websiteId && counted())
    loadScript(config.umami.src, {
      "data-website-id": config.umami.websiteId,
      ...(testing() || !config.url ? {} : { "data-domains": new URL(config.url).hostname }),
    }).then(
      () => {
        const queued = waiting;
        waiting = null;
        for (const [name, data] of queued) send(name, data);
      },
      () => (waiting = null),
    );
  else waiting = null;
  addEventListener("error", (e) => remember(e.message));
  addEventListener("unhandledrejection", (e) => remember(e.reason?.message || String(e.reason)));
}

export function remember(message) {
  if (message) lastError = String(message).slice(0, 300);
}

/**
 * An anonymous event. Names in `once` count the first time per page load
 * only ("this visitor stepped"), which keeps the volume small and says what
 * the numbers need to say.
 */
export function track(name, { first = false, ...data } = {}) {
  if (!enabled) return;
  if (first) {
    if (once.has(name)) return;
    once.add(name);
  }
  const payload = { lang: language(), ...data };
  if (waiting) waiting.push([name, payload]);
  else send(name, payload);
}
function send(name, data) {
  try {
    globalThis.umami?.track(name, data);
  } catch {}
}

/** The environment and latest error shown before a report is sent. */
export function diagnostics(ide) {
  return {
    build: BUILD,
    browser: navigator.userAgent,
    lastError,
  };
}

function programText(files) {
  let text = "";
  for (const [name, body] of Object.entries(files || {})) text += `# ==== ${name} ====\n${body}\n`;
  return text.length > PROGRAM_LIMIT ? text.slice(0, PROGRAM_LIMIT) + "\n# …" : text;
}

function githubIssue(info) {
  const body = `<!-- ${t("feedback.github.prompt")} -->\n\n\n---\n\`\`\`json\n${JSON.stringify(info, null, 2)}\n\`\`\``;
  return `${config.issues}?${new URLSearchParams({ title: "", body })}`;
}

async function openTally(formId, hiddenFields) {
  if (!globalThis.Tally) await loadScript("https://tally.so/widgets/embed.js");
  globalThis.Tally.openPopup(formId, { layout: "modal", width: 560, hiddenFields, onSubmit: () => track("feedback-sent") });
}

/**
 * The feedback dialog: what will be sent, a box for the program (off by
 * default: it may be homework), then the form. `reason` is set when the IDE
 * opened it after a failure.
 */
export function openFeedback(ide, reason = "") {
  if (reason) remember(reason);
  track("feedback-open", { from: reason ? "error" : "button" });
  const info = diagnostics(ide);
  const files = ide.files?.() || {};
  const count = Object.keys(files).length;
  const form = config.tally.feedback;
  // Without the form: a GitHub issue, else an e-mail, else say so.
  const issue = config.issues ? githubIssue(info) : "";
  const mail = config.email
    ? `mailto:${config.email}?${new URLSearchParams({ subject: "MARS Trace feedback", body: `\n\n---\n${JSON.stringify(info, null, 2)}` })}`.replace(/\+/g, "%20")
    : "";
  const fallback = issue || mail;
  const fallbackLabel = issue ? t("feedback.github") : t("feedback.email");
  let actions = "";
  if (form)
    actions =
      `<button id="feedback-continue" class="primary">${t("feedback.continue")}</button>` +
      (fallback ? `<a id="feedback-issue" href="${esc(fallback)}" target="_blank" rel="noopener">${fallbackLabel}</a>` : "");
  else if (fallback) actions = `<button id="feedback-continue" class="primary">${fallbackLabel}</button>`;
  ide.modal(
    t("feedback.title"),
    `<p>${t("feedback.note")}</p>` +
      (reason ? `<p class="feedback-reason">${esc(reason)}</p>` : "") +
      `<details class="feedback-details"><summary>${t("feedback.details")}</summary><pre>${esc(JSON.stringify(info, null, 2))}</pre></details>` +
      (form && count
        ? `<label class="feedback-attach"><input type="checkbox" id="feedback-program"> ${t("feedback.attach", { n: count })}<small>${t("feedback.attach.note")}</small></label>`
        : "") +
      (actions ? `<div class="file-actions">${actions}</div>` : `<p class="feedback-unavailable">${t("feedback.unavailable")}</p>`),
  );
  const go = document.getElementById("feedback-continue");
  if (!go) return;
  go.onclick = async () => {
    const attach = Boolean(document.getElementById("feedback-program")?.checked);
    track("feedback-continue", { program: attach });
    if (!form) {
      open(fallback, "_blank", "noopener");
      document.getElementById("modal").close();
      return;
    }
    document.getElementById("modal").close();
    try {
      await openTally(form, {
        diagnostics: JSON.stringify(info),
        program: attach ? programText(files) : "",
      });
    } catch {
      if (fallback) open(fallback, "_blank", "noopener");
    }
  };
}
