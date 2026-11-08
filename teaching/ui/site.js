// The public static edition's own parts (2026-11-08): anonymous usage events,
// the feedback and report-a-problem flow, and the "by BShark" credit. Only
// the browser build turns these on; the classroom server build is unchanged.
//
// Settings live in site/config.json. Until an id is filled in, analytics is
// off and feedback falls back to a GitHub issue. No cookies, no personal
// data: events carry only the interface language, and a student's program
// goes with a report only when they tick the box for it.
import config from "../site/config.json" with { type: "json" };
import { t, language } from "./i18n/index.js";
import { escapeHTML as esc } from "./model.js";

export const BUILD = typeof __MARS_BUILD__ !== "undefined" ? __MARS_BUILD__ : "dev";
export const site = config;

let enabled = false;
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

/** Start analytics when the build is the public one and an id is set. */
export function startSite(on) {
  enabled = Boolean(on);
  if (!enabled) return;
  document.documentElement.dataset.site = "public";
  if (config.umami.websiteId)
    loadScript(config.umami.src, { "data-website-id": config.umami.websiteId }).catch(() => {});
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
  try {
    globalThis.umami?.track(name, { lang: language(), ...data });
  } catch {}
}

/** What goes with every report: nothing personal, nothing the student wrote. */
export function diagnostics(ide) {
  const s = ide.state?.() || null;
  return {
    build: BUILD,
    runtime: document.documentElement.dataset.runtime || "",
    language: language(),
    browser: navigator.userAgent,
    screen: `${innerWidth}x${innerHeight}`,
    program: s ? { status: s.status || "", step: s.step ?? null, delay: Boolean(ide.delay?.()) } : null,
    files: Object.keys(ide.files?.() || {}).length,
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
  globalThis.Tally.openPopup(formId, { layout: "modal", width: 560, hiddenFields });
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
  ide.modal(
    t("feedback.title"),
    `<p>${t("feedback.note")}</p>` +
      (reason ? `<p class="feedback-reason">${esc(reason)}</p>` : "") +
      `<details class="feedback-details"><summary>${t("feedback.details")}</summary><pre>${esc(JSON.stringify(info, null, 2))}</pre></details>` +
      (form && count
        ? `<label class="feedback-attach"><input type="checkbox" id="feedback-program"> ${t("feedback.attach", { n: count })}<small>${t("feedback.attach.note")}</small></label>`
        : "") +
      `<div class="file-actions"><button id="feedback-continue" class="primary">${form ? t("feedback.continue") : t("feedback.github")}</button>` +
      (form ? `<a id="feedback-issue" href="${esc(githubIssue(info))}" target="_blank" rel="noopener">${t("feedback.github")}</a>` : "") +
      `</div>`,
  );
  document.getElementById("feedback-continue").onclick = async () => {
    const attach = Boolean(document.getElementById("feedback-program")?.checked);
    track("feedback-continue", { program: attach });
    if (!form) {
      open(githubIssue(info), "_blank", "noopener");
      document.getElementById("modal").close();
      return;
    }
    document.getElementById("modal").close();
    try {
      await openTally(form, {
        source: "ide",
        build: info.build,
        language: info.language,
        diagnostics: JSON.stringify(info),
        program: attach ? programText(files) : "",
      });
    } catch {
      open(githubIssue(info), "_blank", "noopener");
    }
  };
}
