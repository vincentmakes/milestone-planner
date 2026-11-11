#!/usr/bin/env python3
"""
Print the manual's print page to a PDF, and check its layout (2.6.0).

The manual (``mkdocs build --strict``, output ``site/``) has one page holding
the User Guide and the Admin Guide: ``print_page/``, made by the
mkdocs-print-site-plugin (``mkdocs.yml``). This script serves the built site
on a local port, opens that page in headless Chromium through Python
Playwright, waits for every image and font, and prints it to an A4 PDF with
backgrounds, a footer (the manual's title, version, page n / total) and an
outline (bookmarks from the headings: Playwright's ``outline`` option).

The Contents page gets page numbers: Chromium has no ``target-counter``, so
the PDF is rendered, the page of each chapter is read from its outline,
the numbers are written into the Contents and the page rendered again,
until the numbers no longer change. In the same rounds, a screenshot that
moved to the next page and left more than a third of a page blank is
shrunk (by at most ``MAX_SHRINK``) so that it, its heading and its
introduction fit where they belong (``image_fits``).

Then the layout is checked on the PDF itself, with pdfplumber (MIT; pinned in
``.github/workflows/manual-pdf.yml`` beside Playwright), and the script
exits non-zero with a list when it finds:

- an image cut by a page edge (a screenshot split across two pages);
- a heading stranded at the bottom of a page (less than two lines, and no
  image, of its section after it on that page);
- text, an image or a box outside the page's text area;
- a Contents page number that differs from the chapter's page, or a
  Contents link that does not lead to that page;
- fewer pages or bytes than the two guides can plausibly take.

Pages whose content ends more than a third of the page early are listed as
a note (the last page of a chapter and the part dividers are expected to).
The print rules themselves are in ``docs/stylesheets/print.css``.

    pip install -r docs/requirements.txt playwright==1.63.0 pdfplumber==0.11.7
    python -m playwright install --with-deps chromium   # where no Chromium is installed
    mkdocs build --strict
    python scripts/docs/export_manual_pdf.py --site-dir site --output Milestone-Manual.pdf

``.github/workflows/manual-pdf.yml`` runs it on every change to the manual
and publishes the result. The check functions are plain Python over page
geometry (``tests/test_export_manual_pdf.py`` runs them without Chromium).
"""

from __future__ import annotations

import argparse
import functools
import html
import http.server
import logging
import re
import sys
import threading
import unicodedata
from dataclasses import dataclass, field
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PRINT_PAGE = "print_page/"
TITLE = "Milestone Planner — User and Admin Manual"
# Below this the PDF cannot hold the two guides and their screenshots.
DEFAULT_MIN_BYTES = 500_000
DEFAULT_MIN_PAGES = 40
LOAD_TIMEOUT_MS = 120_000
# Rendering rounds: the Contents page numbers settle in two, the screenshot
# fitting below in a few more.
MAX_ROUNDS = 8
# A screenshot that did not fit at the bottom of a page may be shrunk to fit
# there, by at most this share of its height (beyond it, it moves on).
MAX_SHRINK = 0.35
# What a fitted screenshot keeps free beyond its group (its paragraph's margins), pt.
FIT_MARGIN = 28.0
# Each further round shrinks a screenshot that still did not fit by this much, pt.
FIT_STEP = 12.0
# A group kept with its screenshot (a heading, an introduction) is at most this tall, pt.
MAX_GROUP_ABOVE = 150.0
# CSS pixels per point.
PX_PER_PT = 96 / 72

# A4 and the margins of `page.pdf`, in points (1 mm = 72 / 25.4 pt).
MM = 72 / 25.4
PAGE_WIDTH = 210 * MM
PAGE_HEIGHT = 297 * MM
MARGINS_MM = {"top": 15, "bottom": 18, "left": 15, "right": 15}
# What may stick out of the text area without being content outside it
# (anti-aliasing, a list bullet's hanging indent, a border's half width).
TOLERANCE = 3.0
# Fewer lines than this after a heading on its page is a stranded heading.
MIN_LINES_AFTER_HEADING = 2
# A page whose content ends more than this share of the text area early is
# listed (a note, not a failure).
EARLY_END_SHARE = 1 / 3

# The page box: A4 with the margins above (the plugin's own `@page` margins
# would otherwise win over `page.pdf`'s), and none of its page-number boxes
# (the footer below replaces them).
PDF_PAGE_CSS = (
    "@page {{ size: A4; margin: {top}mm {right}mm {bottom}mm {left}mm; "
    "@bottom-center {{ content: none; }} @bottom-right {{ content: none; }} }}".format(**MARGINS_MM)
)

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

# The Contents entries: each link to a chapter (or a part), its title, and
# the title of the first heading of what it links to (the outline's entry).
# A page-number box is added to each, empty until the numbers are known.
TOC_ENTRIES = """
() => [...document.querySelectorAll('#print-page-toc a.md-nav__link[href^="#"]')]
  .filter((a) => a.getClientRects().length > 0)
  .map((a) => {
  const target = document.getElementById(a.getAttribute('href').slice(1));
  const heading = target && (target.matches('h1,h2,h3,h4,h5,h6') ? target : target.querySelector('h1,h2,h3,h4,h5,h6'));
  if (!a.querySelector('.milestone-toc-page')) {
    const box = document.createElement('span');
    box.className = 'milestone-toc-page';
    a.appendChild(box);
  }
  return {
    label: (a.querySelector('.md-ellipsis') || a).textContent.trim(),
    target: a.getAttribute('href').slice(1),
    heading: heading ? heading.textContent.replace(/\\u00b6/g, '').trim() : null,
  };
})
"""

# Every displayed raster image of the print page, in document order (the PDF
# draws them in the same order; an SVG becomes vector paths, not an image),
# and a height limit for some of them, in px.
COUNT_IMAGES = """
() => [...document.querySelectorAll('#print-site-page img, #print-site-cover-page img')]
  .filter((img) => img.getClientRects().length > 0 && !/\\.svg(\\?|#|$)/i.test(img.currentSrc || img.src)).length
"""

SET_IMAGE_LIMITS = """
(limits) => {
  const images = [...document.querySelectorAll('#print-site-page img, #print-site-cover-page img')]
    .filter((img) => img.getClientRects().length > 0 && !/\\.svg(\\?|#|$)/i.test(img.currentSrc || img.src));
  for (const [index, px] of Object.entries(limits)) {
    const img = images[Number(index)];
    if (img) img.style.maxHeight = `${px}px`;
  }
}
"""

# A paragraph keeps with the screenshot, table, list, code or note it
# introduces only when it reads as an introduction (it ends with a colon):
# the others are marked so that print.css lets the page break after them.
MARK_LOOSE_PARAGRAPHS = """
() => {
  let count = 0;
  for (const p of document.querySelectorAll('#print-site-page p')) {
    if (p.querySelector(':scope > img')) continue;
    if (!/:\\s*$/.test(p.textContent)) { p.classList.add('milestone-loose'); count += 1; }
  }
  return count;
}
"""

SET_TOC_NUMBERS = """
(numbers) => {
  const boxes = [...document.querySelectorAll('#print-page-toc a.md-nav__link[href^="#"] .milestone-toc-page')]
    .filter((box) => box.parentElement.getClientRects().length > 0);
  boxes.forEach((box, i) => { box.textContent = numbers[i] == null ? '' : String(numbers[i]); });
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


# =============================================================================
# The layout, as plain data (read from the PDF by `read_layout`)
# =============================================================================


@dataclass(frozen=True)
class Box:
    """A thing drawn on a page, top-down coordinates in points."""

    x0: float
    top: float
    x1: float
    bottom: float
    kind: str  # "line" (a line of text), "image" or "rect"
    text: str = ""


@dataclass
class Page:
    number: int  # 1-based
    width: float
    height: float
    boxes: list[Box] = field(default_factory=list)


@dataclass(frozen=True)
class Heading:
    """An outline entry: a heading's title, level, page and top (top-down)."""

    title: str
    level: int
    page: int  # 1-based
    top: float


@dataclass(frozen=True)
class Area:
    """The text area of a page (inside the margins), top-down."""

    left: float
    top: float
    right: float
    bottom: float

    @property
    def height(self) -> float:
        return self.bottom - self.top


def text_area(width: float = PAGE_WIDTH, height: float = PAGE_HEIGHT) -> Area:
    return Area(
        left=MARGINS_MM["left"] * MM,
        top=MARGINS_MM["top"] * MM,
        right=width - MARGINS_MM["right"] * MM,
        bottom=height - MARGINS_MM["bottom"] * MM,
    )


def normalise(title: str) -> str:
    """A title compared by its letters and digits only (no ¶, spacing, case)."""
    folded = unicodedata.normalize("NFKC", title).casefold()
    return "".join(ch for ch in folded if ch.isalnum())


def body(page: Page, area: Area) -> list[Box]:
    """
    What a page holds above its footer (the footer sits in the bottom margin),
    without the page-high background of the layout.
    """
    return [
        b
        for b in page.boxes
        if b.top < area.bottom + TOLERANCE
        and not (b.kind == "rect" and b.bottom - b.top > area.height * 0.9)
    ]


# =============================================================================
# The checks (pure: tested in tests/test_export_manual_pdf.py)
# =============================================================================


def cut_images(pages: list[Page], area: Area) -> list[str]:
    """Images cut by a page edge: drawn beyond the top or the bottom of the text area."""
    out = []
    for page in pages:
        for box in page.boxes:
            if box.kind != "image":
                continue
            if box.top < area.top - TOLERANCE or box.bottom > area.bottom + TOLERANCE:
                out.append(
                    f"page {page.number}: an image is cut by the page edge "
                    f"(from y={box.top:.0f} to y={box.bottom:.0f} pt)"
                )
    return out


def outside_area(pages: list[Page], area: Area) -> list[str]:
    """Text, images or boxes beyond the left or right edge of the text area."""
    out = []
    for page in pages:
        for box in body(page, area):
            if box.x0 < area.left - TOLERANCE or box.x1 > area.right + TOLERANCE:
                what = f'"{box.text[:40]}"' if box.text else f"an {box.kind}"
                out.append(
                    f"page {page.number}: {what} runs outside the text area "
                    f"(x={box.x0:.0f}–{box.x1:.0f} pt, area {area.left:.0f}–{area.right:.0f})"
                )
    return out


def stranded_headings(headings: list[Heading], pages: list[Page], area: Area) -> list[str]:
    """
    Headings left at the bottom of a page: after the heading's own lines, its
    page holds fewer than ``MIN_LINES_AFTER_HEADING`` lines and no image.
    The first heading of a page that is the only thing on it (a part
    divider) is not one.
    """
    by_number = {page.number: page for page in pages}
    out = []
    for heading in headings:
        page = by_number.get(heading.page)
        if page is None:
            continue
        wanted = normalise(heading.title)
        content = sorted(body(page, area), key=lambda b: b.top)
        own: list[Box] = []
        seen = ""
        for box in content:
            if box.kind != "line" or box.top < heading.top - TOLERANCE or len(seen) >= len(wanted):
                continue
            words = normalise(box.text)
            if words and wanted.startswith(seen + words):
                own.append(box)
                seen += words
        if not own:
            continue
        end = max(b.bottom for b in own)
        after = [b for b in content if b.top >= end - 1 and b not in own]
        lines = sum(1 for b in after if b.kind == "line")
        images = sum(1 for b in after if b.kind == "image")
        others = [b for b in content if b not in own]
        if not others:
            continue  # alone on its page: a part divider or a cover title
        if images == 0 and lines < MIN_LINES_AFTER_HEADING:
            out.append(
                f'page {page.number}: the heading "{heading.title}" is left at the bottom '
                f"of the page ({lines} line(s) of its section follow it there)"
            )
    return out


def chapter_ends(headings: list[Heading], pages: list[Page]) -> set[int]:
    """The pages before a chapter or part starts (its first heading, level 1), and the last page."""
    ends = {h.page - 1 for h in headings if h.level == 1 and h.page > 1}
    if pages:
        ends.add(pages[-1].number)
    return ends


def early_pages(pages: list[Page], area: Area, share: float = EARLY_END_SHARE) -> list[int]:
    """Pages whose content ends more than ``share`` of the text area early."""
    out = []
    for page in pages:
        content = body(page, area)
        if not content:
            continue
        end = max(b.bottom for b in content)
        if area.bottom - end > area.height * share:
            out.append(page.number)
    return out


def toc_mismatches(
    entries: list[dict], written: list[int | None], headings: list[Heading]
) -> list[str]:
    """
    Contents entries whose written page number is not the page of their
    chapter: the outline holds no heading of that title on that page.
    """
    out = []
    for entry, wrote in zip(entries, written, strict=True):
        label = entry.get("label", "")
        if wrote is None:
            out.append(f'Contents: "{label}" leads nowhere in the PDF')
            continue
        wanted = normalise(entry.get("heading") or label)
        pages = [h.page for h in headings if normalise(h.title) == wanted]
        if wrote not in pages:
            where = ", ".join(map(str, pages)) or "no page"
            out.append(f'Contents: "{label}" says page {wrote}, its heading is on {where}')
    return out


def toc_pages(entries: list[dict], destinations: dict[str, int]) -> list[int | None]:
    """The page of each Contents entry: where its link's target (an element id) lands."""
    return [destinations.get(entry.get("target") or "") for entry in entries]


def image_order(pages: list[Page]) -> list[tuple[int, Box]]:
    """Every image drawn, in reading order: (page number, box)."""
    out = []
    for page in pages:
        images = sorted(
            (b for b in page.boxes if b.kind == "image"), key=lambda b: (round(b.top), b.x0)
        )
        out.extend((page.number, box) for box in images)
    return out


def image_fits(
    pages: list[Page], area: Area, skip: set[int], max_shrink: float = MAX_SHRINK
) -> dict[int, float]:
    """
    Screenshots to shrink so that they stay on the page they belong to: for
    each page (not in ``skip``: chapter ends) whose content ends more than a
    third early because the next page starts with a group holding an image
    (a heading, its introduction, the picture), the new height in points of
    that image (by its index in ``image_order``) that makes the group fit in
    the blank space, when that takes no more than ``max_shrink`` of it.
    """
    order = image_order(pages)
    index_of = {(number, id(box)): i for i, (number, box) in enumerate(order)}
    by_number = {page.number: page for page in pages}
    out: dict[int, float] = {}
    for number in early_pages(pages, area):
        nxt = by_number.get(number + 1)
        if number in skip or nxt is None:
            continue
        content = body(by_number[number], area)
        blank = area.bottom - max(b.bottom for b in content) - 8  # a margin of safety
        following = sorted(body(nxt, area), key=lambda b: b.top)
        images = [b for b in following if b.kind == "image"]
        if not images:
            continue
        image = images[0]
        if image.top - area.top > MAX_GROUP_ABOVE:
            continue  # the picture is not what moved: something long precedes it
        # The group: from the top of the page to the bottom of its first image.
        group = image.bottom - area.top
        height = image.bottom - image.top
        # The image's paragraph margins come back with it at the bottom of the page.
        excess = group - blank + FIT_MARGIN
        if 0 < excess <= height * max_shrink:
            out[index_of[(number + 1, id(image))]] = height - excess
    return out


def link_mismatches(
    labels: list[str], written: list[int | None], targets: list[int | None]
) -> list[str]:
    """Contents links (in reading order) that do not lead to the page their entry names."""
    if len(targets) != len(labels):
        return [f"Contents: {len(targets)} links for {len(labels)} entries"]
    return [
        f'Contents: the link of "{label}" leads to page {target}, not to page {wrote}'
        for label, wrote, target in zip(labels, written, targets, strict=True)
        if target != wrote
    ]


def size_problems(pages: int, size: int, min_pages: int, min_bytes: int) -> list[str]:
    if pages < min_pages or size < min_bytes:
        return [
            f"The PDF is implausibly small: {pages} pages and {size:,} bytes "
            f"(at least {min_pages} pages and {min_bytes:,} bytes expected)"
        ]
    return []


# =============================================================================
# Reading the PDF (pdfplumber)
# =============================================================================


def read_layout(path: Path) -> tuple[list[Page], list[Heading]]:
    """The boxes of every page and the outline of the PDF at ``path``."""
    import pdfplumber

    # pdfminer warns about every font Chromium embeds without a bounding box.
    logging.getLogger("pdfminer").setLevel(logging.ERROR)
    pages: list[Page] = []
    headings: list[Heading] = []
    with pdfplumber.open(path) as pdf:
        page_ids = {p.page_obj.pageid: p.page_number for p in pdf.pages}
        for p in pdf.pages:
            page = Page(number=p.page_number, width=float(p.width), height=float(p.height))
            for line in p.extract_text_lines(return_chars=False):
                page.boxes.append(
                    Box(line["x0"], line["top"], line["x1"], line["bottom"], "line", line["text"])
                )
            for image in p.images:
                page.boxes.append(
                    Box(image["x0"], image["top"], image["x1"], image["bottom"], "image")
                )
            for rect in p.rects:
                # Backgrounds and borders of tables, code and notes (hairlines skipped).
                if rect["width"] > 2 and rect["height"] > 2:
                    page.boxes.append(
                        Box(rect["x0"], rect["top"], rect["x1"], rect["bottom"], "rect")
                    )
            pages.append(page)
        try:
            outlines = list(pdf.doc.get_outlines())
        except Exception:  # noqa: BLE001 - a PDF without an outline
            outlines = []
        for level, title, dest, _action, _se in outlines:
            if not dest or not isinstance(dest, list):
                continue
            ref = dest[0]
            number = page_ids.get(getattr(ref, "objid", None))
            if number is None:
                continue
            height = pages[number - 1].height
            top = height - float(dest[3]) if len(dest) > 3 and dest[3] is not None else 0.0
            headings.append(Heading(title=str(title), level=int(level), page=number, top=top))
    return pages, headings


def destinations(path: Path) -> dict[str, int]:
    """The named destinations of the PDF (Chromium names each linked id): id -> page."""
    import pdfplumber
    from pdfminer.pdftypes import resolve1

    logging.getLogger("pdfminer").setLevel(logging.ERROR)
    out: dict[str, int] = {}
    with pdfplumber.open(path) as pdf:
        page_ids = {p.page_obj.pageid: p.page_number for p in pdf.pages}
        for name, value in (resolve1(pdf.doc.catalog.get("Dests")) or {}).items():
            target = resolve1(value)
            ref = target[0] if isinstance(target, list) and target else None
            number = page_ids.get(getattr(ref, "objid", None))
            if number is not None:
                out[str(name)] = number
    return out


def contents_links(path: Path, headings: list[Heading]) -> list[int | None]:
    """
    Where the links of the Contents lead, in reading order: the page of each
    named destination (Chromium links an anchor by its id). The Contents runs
    from its own heading's page to the page before the next level-1 heading.
    """
    import pdfplumber
    from pdfminer.pdftypes import resolve1

    logging.getLogger("pdfminer").setLevel(logging.ERROR)
    start = next((h.page for h in headings if normalise(h.title) == "contents"), None)
    if start is None:
        return []
    end = min((h.page for h in headings if h.level == 1 and h.page > start), default=start + 1) - 1
    out: list[int | None] = []
    with pdfplumber.open(path) as pdf:
        page_ids = {p.page_obj.pageid: p.page_number for p in pdf.pages}
        dests = resolve1(pdf.doc.catalog.get("Dests")) or {}
        for p in pdf.pages[start - 1 : end]:
            for annot in sorted(p.annots, key=lambda a: (round(a["top"]), a["x0"])):
                name = annot["data"].get("Dest")
                target = resolve1(dests.get(getattr(name, "name", name))) if name else None
                ref = target[0] if isinstance(target, list) and target else None
                out.append(page_ids.get(getattr(ref, "objid", None)))
    return out


# =============================================================================
# Export
# =============================================================================


def render(page, path: Path, version: str) -> None:  # page: playwright Page
    page.pdf(
        path=str(path),
        format="A4",
        print_background=True,
        display_header_footer=True,
        header_template="<span></span>",
        footer_template=footer(version),
        margin={side: f"{mm}mm" for side, mm in MARGINS_MM.items()},
        outline=True,
        tagged=True,
    )


def export(site_dir: Path, output: Path, version: str, min_bytes: int, min_pages: int) -> int:
    from playwright.sync_api import sync_playwright

    if not (site_dir / PRINT_PAGE / "index.html").is_file():
        print(f"No print page in {site_dir}: run `mkdocs build --strict` first", file=sys.stderr)
        return 1

    server = serve(site_dir)
    url = f"http://127.0.0.1:{server.server_address[1]}/{PRINT_PAGE}"
    output.parent.mkdir(parents=True, exist_ok=True)
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
                page.evaluate(MARK_LOOSE_PARAGRAPHS)
                entries = page.evaluate(TOC_ENTRIES)
                labels = [entry["label"] for entry in entries]
                images = page.evaluate(COUNT_IMAGES)
                written: list[int | None] = [None] * len(entries)
                found: list[int | None] = []
                limits: dict[int, float] = {}  # image index -> max height in pt
                natural: dict[int, float] = {}  # image index -> its height before fitting
                for round_ in range(1, MAX_ROUNDS + 1):
                    page.evaluate(SET_TOC_NUMBERS, written)
                    page.evaluate(
                        SET_IMAGE_LIMITS,
                        {str(i): round(pt * PX_PER_PT, 1) for i, pt in limits.items()},
                    )
                    render(page, output, version)
                    pages, headings = read_layout(output)
                    found = toc_pages(entries, destinations(output))
                    drawn = len(image_order(pages))
                    if drawn != images:
                        print(f"Note: {drawn} images drawn, {images} in the page: no fitting")
                    fits = (
                        {}
                        if drawn != images
                        else image_fits(
                            pages,
                            text_area(pages[0].width, pages[0].height),
                            chapter_ends(headings, pages),
                        )
                    )
                    for index, (_number, box) in enumerate(image_order(pages)):
                        natural.setdefault(index, box.bottom - box.top)
                    fits = {
                        i: max(
                            min(pt, limits.get(i, float("inf")) - FIT_STEP),
                            natural[i] * (1 - MAX_SHRINK),
                        )
                        for i, pt in fits.items()
                    }
                    fits = {i: pt for i, pt in fits.items() if pt < limits.get(i, float("inf")) - 1}
                    if found == written and not fits:
                        print(
                            f"Layout settled after {round_} rendering(s): Contents numbered, "
                            f"{len(limits)} screenshot(s) fitted to their page"
                        )
                        break
                    written = found
                    limits.update(fits)
                else:
                    print(f"Layout not settled after {MAX_ROUNDS} renderings", file=sys.stderr)
            finally:
                browser.close()
    finally:
        server.shutdown()

    data = output.read_bytes()
    pages, headings = read_layout(output)
    area = text_area(pages[0].width, pages[0].height) if pages else text_area()
    print(f"{output}: {len(pages)} pages, {len(data):,} bytes, {len(headings)} bookmarks")

    problems = [
        *size_problems(len(pages), len(data), min_pages, min_bytes),
        *cut_images(pages, area),
        *stranded_headings(headings, pages, area),
        *outside_area(pages, area),
        *toc_mismatches(entries, written, headings),
        *link_mismatches(labels, written, contents_links(output, headings)),
    ]
    numbered = sum(1 for number in written if number is not None)
    print(f"Contents: {numbered} of {len(written)} entries numbered and checked, with their links")
    short = early_pages(pages, area)
    ends = chapter_ends(headings, pages)
    expected = [n for n in short if n in ends]
    other = [n for n in short if n not in ends]
    print(
        f"Pages ending more than a third early: {len(expected)} at the end of a chapter "
        f"or part ({', '.join(map(str, expected)) or 'none'}), {len(other)} elsewhere "
        f"({', '.join(map(str, other)) or 'none'})"
    )
    if problems:
        print(f"The PDF's layout has {len(problems)} problem(s):", file=sys.stderr)
        for problem in problems:
            print(f"  - {problem}", file=sys.stderr)
        return 1
    print("Layout checks passed: no cut image, no stranded heading, nothing outside the text area")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=(__doc__ or "").split("\n\n")[0])
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
