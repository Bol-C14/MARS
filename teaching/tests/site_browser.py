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
    ok("/app/?example=01-hello" in hrefs and "/app/#feedback" in hrefs, "try and feedback links point into the IDE")
    ok(page.locator(".actions a.button.primary").get_attribute("href") == "/app/", "main action opens the IDE without replacing a project")
    ok(page.locator('link[hreflang="zh-CN"]').get_attribute("href").endswith("/zh-cn/"), "Chinese page is discoverable")
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
    ok(page.locator("#feedback-open").is_visible(), "feedback shows")
    ok("BShark" not in page.content() and "Bol-C14" not in page.content(), "the IDE names no person")
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
    page.goto(URL + "/")
    page.click(".actions a.button.primary")
    page.wait_for_function("window.marsIDE?.editor")
    ok(page.locator("#modal").evaluate("e => !e.open"), "main action does not ask to replace the project")
    ok("# mine" in page.evaluate("window.marsIDE.editor.state.doc.toString()"), "main action keeps the current work")

    # Feedback: diagnostics, never the program unless asked.
    page.click("#feedback-open")
    pre = page.text_content(".feedback-details pre")
    info = json.loads(pre)
    ok(set(info) == {"build", "browser", "lastError"}, "diagnostics show the approved environment and error fields")
    ok("# mine" not in pre and "Fizz" not in pre, "diagnostics carry no source")
    ok(not page.locator("#feedback-program").is_checked(), "program attachment is off by default")
    page.evaluate("document.getElementById('modal').close()")

    # #feedback from the site opens the dialog.
    page = ctx.new_page()
    page.goto(URL + "/app/#feedback")
    page.wait_for_selector("#modal[open] .feedback-details")
    ok(page.url.endswith("/app/"), "the hash is cleared")
    ctx.close()

    # Analytics, when an Umami id is configured: the real tracker loads, but
    # what it would send is caught here, so a test run never reaches the
    # dashboard. Skipped offline.
    config = json.loads((Path(__file__).resolve().parents[1] / "site" / "config.json").read_text())
    # Without the test flag a local copy loads no tracker at all.
    if config["umami"]["websiteId"]:
        ctx = browser.new_context()
        page = ctx.new_page()
        page.goto(URL + "/")
        page.wait_for_timeout(800)
        ok(not page.evaluate("!!window.umami || !!document.querySelector('script[data-website-id]')"), "local pages send nothing")
        page.goto(URL + "/app/")
        page.wait_for_function("window.marsIDE")
        page.wait_for_timeout(800)
        ok(not page.evaluate("!!window.umami"), "the local IDE sends nothing")
        ctx.close()
    if config["umami"]["websiteId"]:
        sent = []
        ctx = browser.new_context(locale="en")

        def catch(route):
            body = route.request.post_data_json or {}
            sent.append(body.get("payload", {}))
            route.fulfill(status=200, content_type="application/json", body="{}")

        ctx.route("**/api/send", catch)
        ctx.add_init_script("localStorage.setItem('mars-trace:analytics-test', '1')")
        page = ctx.new_page()
        utm = "utm_source=chatgpt&utm_medium=ad&utm_campaign=site-test"
        page.goto(f"{URL}/?{utm}")
        try:
            page.wait_for_function("window.umami", timeout=10000)
        except Exception:
            print("site: analytics skipped (tracker unreachable)")
        else:
            names = lambda: [e.get("name") for e in sent]
            page.wait_for_timeout(800)
            views = [e for e in sent if not e.get("name")]
            ok(views and utm in views[0].get("url", ""), "the page view keeps its UTM")
            ok(all(e.get("website") == config["umami"]["websiteId"] for e in sent), "events go to the configured site")
            page.click("[data-switch-lang]")
            page.evaluate("""window.dispatchEvent(new MessageEvent('message', {origin: 'https://tally.so',
                data: JSON.stringify({event: 'Tally.FormSubmitted', payload: {}})}))""")
            page.click(".actions a.button.primary")  # Open the IDE
            page.wait_for_function("window.marsIDE?.editor")
            page.wait_for_timeout(1500)
            app_views = [e for e in sent if not e.get("name") and "/app/" in e.get("url", "")]
            ok(len(app_views) == 1 and "example=" not in app_views[0]["url"], "the IDE counts once, without ?example")
            page.click("#learn-menu-button")
            page.click("#example-list [data-example='0']")
            page.click("#project-confirm")
            page.wait_for_function("window.marsIDE?.state?.status")
            page.click("#step")
            page.wait_for_timeout(300)
            page.click("#step")
            page.wait_for_timeout(300)
            page.click("#back")
            page.click("#feedback-open")
            page.wait_for_timeout(1500)
            got = names()
            for name in ["language", "contact-sent", "try", "example", "assemble", "step", "back", "feedback-open"]:
                ok(name in got, f"event {name} is recorded")
            ok(got.count("step") == 1, "a first step counts once")
            ok(all(isinstance(e.get("data", {}), dict) for e in sent), "events carry only small data")
        ctx.close()
    browser.close()

print(f"site: {checks} checks passed")
