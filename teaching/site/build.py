"""Write the MARS Trace site into teaching/dist: the landing page at the root
and the browser IDE (already built into dist/app) beside it.

Settings come from site/config.json. Empty ids leave a feature off: no
Umami id means no analytics script; no Tally contact form falls back to the
e-mail address, then to GitHub issues.
"""
from html import escape
from pathlib import Path
import json
import shutil

site = Path(__file__).resolve().parent
dist = site.parent / "dist"
config = json.loads((site / "config.json").read_text())

analytics = ""
if config["umami"]["websiteId"]:
    analytics = (
        f'<script defer src="{escape(config["umami"]["src"])}" '
        f'data-website-id="{escape(config["umami"]["websiteId"])}"></script>'
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
else:
    contact = f'href="{escape(config["issues"])}" rel="noopener"'

page = (site / "index.html").read_text()
page = page.replace("{{ANALYTICS}}", analytics).replace("{{CONTACT}}", contact)
page = page.replace("{{GITHUB}}", escape(config["github"]))
assert "{{" not in page, "unfilled placeholder in site/index.html"
(dist / "index.html").write_text(page)
for name in ("site.css", "site.js"):
    shutil.copy(site / name, dist / name)
if (site / "media").is_dir():
    shutil.copytree(site / "media", dist / "media", dirs_exist_ok=True)
