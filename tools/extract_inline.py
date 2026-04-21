"""One-shot extractor: split inline <style> + main <script> out of
public/index.html into public/app.css and public/app.js, then rewrite
the HTML to link to them.

The tiny window.onerror inline script (line ~791) is intentionally kept
inline — it needs to run before any external script loads so it can
catch bootstrap errors.

This script is idempotent-ish: it looks for the exact inline blocks
that exist in the committed file. If they've already been extracted,
it'll no-op with a warning.
"""
from pathlib import Path
import re
import sys

ROOT = Path(__file__).resolve().parent.parent
HTML = ROOT / "public" / "index.html"
CSS_OUT = ROOT / "public" / "app.css"
JS_OUT = ROOT / "public" / "app.js"

INLINE_STYLE_RE = re.compile(r"<style[^>]*>(.*?)</style>", re.DOTALL)
INLINE_SCRIPT_RE = re.compile(
    r"<script(?![^>]*\bsrc=)[^>]*>(.*?)</script>", re.DOTALL
)


def main() -> int:
    html = HTML.read_text(encoding="utf-8")

    # ---- styles ----
    style_matches = list(INLINE_STYLE_RE.finditer(html))
    if not style_matches:
        print("WARN: no inline <style> block found; skipping CSS extract")
    elif len(style_matches) > 1:
        print(f"ERROR: expected 1 inline <style>, found {len(style_matches)}")
        return 1
    else:
        css = style_matches[0].group(1)
        CSS_OUT.write_text(css, encoding="utf-8")
        html = (
            html[: style_matches[0].start()]
            + '<link rel="stylesheet" href="/app.css">'
            + html[style_matches[0].end() :]
        )
        print(f"wrote {CSS_OUT.relative_to(ROOT)} ({len(css):,} bytes)")

    # ---- scripts: keep small ones inline, extract the biggest one ----
    script_matches = list(INLINE_SCRIPT_RE.finditer(html))
    if not script_matches:
        print("WARN: no inline <script> blocks found")
        HTML.write_text(html, encoding="utf-8")
        return 0

    # Identify the main app script = the largest inline script.
    main_idx = max(range(len(script_matches)), key=lambda i: len(script_matches[i].group(1)))
    kept = [m for i, m in enumerate(script_matches) if i != main_idx]
    target = script_matches[main_idx]
    body = target.group(1)

    if len(body) < 10_000:
        print(f"ERROR: largest inline script is only {len(body)} bytes — refusing to extract trivially small script")
        return 1

    JS_OUT.write_text(body, encoding="utf-8")
    html = (
        html[: target.start()]
        + '<script src="/app.js" defer></script>'
        + html[target.end() :]
    )
    print(f"wrote {JS_OUT.relative_to(ROOT)} ({len(body):,} bytes)")
    print(f"kept {len(kept)} smaller inline script(s) in place")

    HTML.write_text(html, encoding="utf-8")
    print(f"rewrote {HTML.relative_to(ROOT)} ({len(html):,} bytes)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
