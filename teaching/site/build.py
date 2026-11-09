"""Write the MARS Trace site into teaching/dist: the landing page at the root
and the browser IDE (already built into dist/app) beside it.

Settings come from site/config.json. Empty ids leave a feature off: no
Umami id means no analytics script; no Tally contact form falls back to the
e-mail address, then to GitHub issues.
"""
from html import escape
from pathlib import Path
import argparse
import json
import re
import shutil
from urllib.parse import urlparse

site = Path(__file__).resolve().parent
parser = argparse.ArgumentParser()
parser.add_argument("--output", type=Path, default=site.parent / "dist")
dist = parser.parse_args().output
dist.mkdir(parents=True, exist_ok=True)
config = json.loads((site / "config.json").read_text())

url = config["url"].rstrip("/") + "/"
host = urlparse(url).hostname
analytics = ""
if config["umami"]["websiteId"]:
    # Local copies (development, tests) never count, unless a test asks to.
    analytics = (
        "<script>(function () {\n"
        "  var local = /^(localhost|127\\.0\\.0\\.1|\\[::1\\])$/.test(location.hostname), test = false;\n"
        "  try { test = localStorage.getItem('mars-trace:analytics-test') === '1'; } catch (e) {}\n"
        "  if (local && !test) return;\n"
        "  var s = document.createElement('script');\n"
        f"  s.defer = true; s.src = {json.dumps(config['umami']['src'])};\n"
        f"  s.setAttribute('data-website-id', {json.dumps(config['umami']['websiteId'])});\n"
        # Only the real site counts; a copy elsewhere (and a test) does not.
        f"  if (!test) s.setAttribute('data-domains', {json.dumps(host)});\n"
        "  document.head.appendChild(s);\n"
        "})();</script>"
    )
if config["tally"]["contact"]:
    form = escape(config["tally"]["contact"])
    contact = (
        f'href="https://tally.so/r/{form}" data-tally-open="{form}" '
        'data-tally-layout="modal" data-tally-width="560"'
    )
    analytics += '\n    <script async src="https://tally.so/widgets/embed.js"></script>'
elif config["email"]:
    contact = f'href="mailto:{escape(config["email"])}"'
elif config["issues"]:
    contact = f'href="{escape(config["issues"])}" rel="noopener"'
else:
    # Nothing set up yet: the feedback dialog in the IDE explains.
    contact = 'href="app/#feedback"'

template = (site / "index.html").read_text()
template = template.replace("{{ANALYTICS}}", analytics).replace("{{CONTACT}}", contact).replace("{{URL}}", escape(url))
github = config["github"]
template = template.replace(
    "{{GITHUB}}", f' · <a href="{escape(github)}" rel="noopener">GitHub</a>' if github else ""
)
versions = [
    ("en", "", "Online MIPS Simulator & Assembly Debugger | MARS Trace",
     "Run MIPS assembly online with the MARS 4.5 assembler and simulator. Step, rewind, and explore registers and memory in your browser."),
    ("zh-CN", "zh-cn/", "在线 MIPS 汇编模拟器与调试工具 | MARS Trace",
     "在线汇编和运行 MIPS 程序，单步调试、回退并查看寄存器和内存。基于 MARS 4.5，适合计算机组成与汇编语言教学。"),
]
for lang, path, title, description in versions:
    page = template
    for key, value in {
        "PAGE_LANG": lang, "PAGE_URL": url + path, "PAGE_TITLE": title,
        "PAGE_DESCRIPTION": description, "SWITCH_URL": "/" if path else "/zh-cn/",
    }.items():
        page = page.replace("{{" + key + "}}", escape(value, quote=True))
    assert "{{" not in page, "unfilled placeholder in site/index.html"
    target = dist / path / "index.html"
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(page)
for name in ("site.css", "site.js"):
    shutil.copy(site / name, dist / name)
(dist / "robots.txt").write_text(f"User-agent: *\nAllow: /\nSitemap: {url}sitemap.xml\n")
(dist / "sitemap.xml").write_text(
    '<?xml version="1.0" encoding="UTF-8"?>\n'
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
    f"  <url><loc>{escape(url)}</loc></url>\n"
    f"  <url><loc>{escape(url)}zh-cn/</loc></url>\n"
    f"  <url><loc>{escape(url)}app/</loc></url>\n</urlset>\n"
)
app = dist / "app" / "index.html"
if app.exists():
    content = app.read_text()
    content = re.sub(r"<title>.*?</title>", "<title>Online MIPS Simulator and Debugger | MARS Trace</title>", content, count=1)
    content = re.sub(r"\s*<!-- site-search:start -->.*?<!-- site-search:end -->", "", content, flags=re.S)
    meta = (
        '\n    <!-- site-search:start -->\n'
        '    <meta name="description" content="Write, assemble and debug MIPS assembly online. Step forward and back, inspect registers and memory, and run MARS 4.5 programs in your browser." />\n'
        f'    <link rel="canonical" href="{escape(url)}app/" />\n'
        '    <!-- site-search:end -->'
    )
    content = content.replace("</title>", "</title>" + meta, 1)
    app.write_text(content)
if (site / "media").is_dir():
    shutil.copytree(site / "media", dist / "media", dirs_exist_ok=True)
