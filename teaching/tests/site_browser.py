"""The public site (2026-11-08): product page, linked examples, feedback.

Run against a built site (sh teaching/scripts/build-browser.sh), served from
teaching/dist:  python3 teaching/tests/site_browser.py http://127.0.0.1:8877
"""
import json
import sys
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from browser_acceptance import launch  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

URL = (sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8877").rstrip("/")
checks = 0


def ok(cond, what):
    global checks
    if not cond:
        raise AssertionError(what)
    checks += 1


for path in ["/", "/site.css", "/site.js", "/media/ide-en.png", "/media/ide-zh-CN.png", "/app/", "/app/kernel.js",
             "/app/examples.json", "/app/MARSlicense.txt", "/app/TEAVM-LICENSE.txt"]:
    with urllib.request.urlopen(URL + path) as r:
        ok(r.status == 200, f"{path} is served")

with sync_playwright() as p:
    browser = launch(p)
    # Product page: one language at a time, the switch remembered for the IDE.
    ctx = browser.new_context(locale="zh-CN")
    page = ctx.new_page()
    page.goto(URL + "/")
    ok(page.evaluate("document.documentElement.dataset.lang") == "zh-CN", "a Chinese browser reads Chinese")
    ok(page.locator("h1 [lang=en]").is_hidden() and page.locator("h1 [lang=zh-CN]").is_visible(), "only one language shows")
    ok("{{" not in page.content(), "no unfilled placeholder")
    page.click("[data-switch-lang]")
    ok(page.locator("h1 [lang=en]").is_visible(), "the switch changes language")
    ok(page.evaluate("localStorage.getItem('mars-trace:language')") == "en", "the choice is stored for the IDE")
    hrefs = page.eval_on_selector_all("a[href]", "as => as.map(a => a.getAttribute('href'))")
    ok("app/?example=01-hello" in hrefs and "app/#feedback" in hrefs, "try and feedback links point into the IDE")
    ok(not page.evaluate("document.cookie"), "the page sets no cookie")
    # Layout holds at phone width.
    page.set_viewport_size({"width": 375, "height": 800})
    ok(page.evaluate("document.documentElement.scrollWidth <= innerWidth"), "no sideways scroll on a phone")

    # A linked example opens at once on a first visit, and the link is tidied.
    page.goto(URL + "/app/?example=03-fizzbuzz")
    page.wait_for_function("window.marsIDE?.state?.status")
    ok("FizzBuzz" in page.text_content("#project-title"), "the linked example is the project")
    ok("example=" not in page.url, "the example parameter is removed")
    ok(page.evaluate("document.documentElement.dataset.site") == "public", "the public parts are on")
    ok(page.locator("#feedback-open").is_visible() and page.locator(".footer-credit").is_visible(), "feedback and credit show")
    # A failure (with a program loaded) of the IDE itself offers a report with the error filled in.
    page.evaluate("window.marsIDE.command('no-such-command')")
    page.wait_for_selector(".banner-report")
    page.click(".banner-report")
    ok("Unknown command" in page.text_content(".feedback-reason"), "the report names the failure")
    page.evaluate("document.getElementById('modal').close()")

    # The same link with work of one's own asks first.
    page.evaluate("window.marsIDE.editor.dispatch({changes:{from:0, insert:'# mine\\n'}})")
    page.wait_for_timeout(600)
    page.goto(URL + "/app/?example=01-hello")
    page.wait_for_selector("#modal[open]")
    ok("FizzBuzz" in page.text_content("#project-title"), "own work stays until the student agrees")
    page.evaluate("document.getElementById('modal').close()")

    # Feedback: diagnostics, never the program unless asked.
    page.click("#feedback-open")
    pre = page.text_content(".feedback-details pre")
    info = json.loads(pre)
    ok(info["runtime"] == "browser" and info["files"] == 1 and "build" in info, "diagnostics describe the setup")
    ok("# mine" not in pre and "Fizz" not in pre, "diagnostics carry no source")
    page.evaluate("document.getElementById('modal').close()")

    # #feedback from the site opens the dialog.
    page = ctx.new_page()
    page.goto(URL + "/app/#feedback")
    page.wait_for_selector("#modal[open] .feedback-details")
    ok(page.url.endswith("/app/"), "the hash is cleared")
    ctx.close()
    browser.close()

print(f"site: {checks} checks passed")
