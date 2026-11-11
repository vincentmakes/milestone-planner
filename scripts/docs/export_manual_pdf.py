#!/usr/bin/env python3
"""
Print the manual's print page to a PDF (2.6.0).

The manual (``mkdocs build --strict``, output ``site/``) has one page holding
the User Guide and the Admin Guide: ``print_page/``, made by the
mkdocs-print-site-plugin (``mkdocs.yml``). This script serves the built site
on a local port, opens that page in headless Chromium through Python
Playwright, waits for every image and font, and prints it to an A4 PDF with
backgrounds and a footer (the manual's title, version, page numbers).

    pip install -r docs/requirements.txt playwright
    python -m playwright install --with-deps chromium   # where no Chromium is installed
    mkdocs build --strict
    python scripts/docs/export_manual_pdf.py --site-dir site --output Milestone-Manual.pdf

``.github/workflows/manual-pdf.yml`` runs it on every change to the manual
and publishes the result. Exits non-zero when the page does not load or the
PDF is implausibly small.
"""

from __future__ import annotations

import argparse
import functools
import html
import http.server
import re
import sys
import threading
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PRINT_PAGE = "print_page/"
TITLE = "Milestone Planner — User and Admin Manual"
# Below this the PDF cannot hold the two guides and their screenshots.
DEFAULT_MIN_BYTES = 500_000
DEFAULT_MIN_PAGES = 40
LOAD_TIMEOUT_MS = 120_000

PDF_PAGE_CSS = "@page { @bottom-center { content: none; } @bottom-right { content: none; } }"

# Every image eager (the screenshots are ``loading=lazy`` and would print as
# blanks below the first screen), then wait until each has loaded or failed.
WAIT_FOR_IMAGES = """
async () => {
  for (const img of document.images) img.loading = 'eager';
  await Promise.all([...document.images].map((img) =>
    img.complete ? null : new Promise((done) => { img.onload = img.onerror = done; })));
  await document.fonts.ready;
  return [...document.images].filter((img) => img.naturalWidth === 0).map((img) => img.src);
}
"""


class _QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, format: str, *args: object) -> None:  # noqa: A002
        pass


def serve(site_dir: Path) -> http.server.ThreadingHTTPServer:
    """Serve ``site_dir`` on 127.0.0.1, on a free port, from a daemon thread."""
    handler = functools.partial(_QuietHandler, directory=str(site_dir))
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


def footer(version: str) -> str:
    """The footer of every page: the manual's title and version, and the page number."""
    label = html.escape(f"{TITLE} · {version}" if version else TITLE)
    return (
        '<div style="width:100%;font-size:8px;color:#666;padding:0 15mm;'
        'display:flex;justify-content:space-between;font-family:sans-serif;">'
        f"<span>{label}</span>"
        '<span><span class="pageNumber"></span> / <span class="totalPages"></span></span>'
        "</div>"
    )


def page_count(pdf: bytes) -> int:
    """The number of pages of a PDF Chromium wrote (its page objects)."""
    return len(re.findall(rb"/Type\s*/Page(?!s)", pdf))


def export(site_dir: Path, output: Path, version: str, min_bytes: int, min_pages: int) -> int:
    from playwright.sync_api import sync_playwright

    if not (site_dir / PRINT_PAGE / "index.html").is_file():
        print(f"No print page in {site_dir}: run `mkdocs build --strict` first", file=sys.stderr)
        return 1

    server = serve(site_dir)
    url = f"http://127.0.0.1:{server.server_address[1]}/{PRINT_PAGE}"
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch()
            try:
                page = browser.new_page()
                response = page.goto(url, wait_until="networkidle", timeout=LOAD_TIMEOUT_MS)
                if response is None or not response.ok:
                    status = response.status if response else "no response"
                    print(f"The print page did not load ({status}): {url}", file=sys.stderr)
                    return 1
                page.wait_for_selector("#print-site-page", timeout=LOAD_TIMEOUT_MS)
                broken = page.evaluate(WAIT_FOR_IMAGES)
                if broken:
                    print(f"Images that did not load: {', '.join(broken)}", file=sys.stderr)
                    return 1
                # The plugin's own page-number boxes (for printing from the
                # browser) give way to this footer.
                page.add_style_tag(content=PDF_PAGE_CSS)
                page.emulate_media(media="print")
                output.parent.mkdir(parents=True, exist_ok=True)
                page.pdf(
                    path=str(output),
                    format="A4",
                    print_background=True,
                    display_header_footer=True,
                    header_template="<span></span>",
                    footer_template=footer(version),
                    margin={"top": "15mm", "bottom": "18mm", "left": "15mm", "right": "15mm"},
                )
            finally:
                browser.close()
    finally:
        server.shutdown()

    data = output.read_bytes()
    pages = page_count(data)
    print(f"{output}: {pages} pages, {len(data):,} bytes")
    if len(data) < min_bytes or pages < min_pages:
        print(
            f"The PDF is implausibly small (at least {min_pages} pages and "
            f"{min_bytes:,} bytes expected)",
            file=sys.stderr,
        )
        return 1
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--site-dir", type=Path, default=ROOT / "site", help="the built manual")
    parser.add_argument(
        "--output", type=Path, default=Path("Milestone-Manual.pdf"), help="the PDF to write"
    )
    parser.add_argument(
        "--version", default=None, help="the version in the footer (default: /VERSION)"
    )
    parser.add_argument("--min-bytes", type=int, default=DEFAULT_MIN_BYTES)
    parser.add_argument("--min-pages", type=int, default=DEFAULT_MIN_PAGES)
    args = parser.parse_args(argv)
    version = args.version
    if version is None:
        version_file = ROOT / "VERSION"
        version = version_file.read_text(encoding="utf-8").strip() if version_file.is_file() else ""
    return export(args.site_dir, args.output, version, args.min_bytes, args.min_pages)


if __name__ == "__main__":
    sys.exit(main())
