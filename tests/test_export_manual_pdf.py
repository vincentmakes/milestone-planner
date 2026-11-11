"""
The layout checks of the manual's PDF export (scripts/docs/export_manual_pdf.py),
on small synthetic pages: no Chromium and no PDF needed.
"""

import importlib.util
import sys
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "docs" / "export_manual_pdf.py"
_spec = importlib.util.spec_from_file_location("export_manual_pdf", SCRIPT)
assert _spec and _spec.loader
pdf = importlib.util.module_from_spec(_spec)
# Registered before running it: its dataclasses look their module up.
sys.modules["export_manual_pdf"] = pdf
_spec.loader.exec_module(pdf)

AREA = pdf.Area(left=40, top=40, right=560, bottom=800)


def line(top, text="Some words of a paragraph", x0=50, x1=500, height=10):
    return pdf.Box(x0, top, x1, top + height, "line", text)


def image(top, bottom, x0=50, x1=500):
    return pdf.Box(x0, top, x1, bottom, "image")


def page(number, *boxes):
    return pdf.Page(number=number, width=600, height=840, boxes=list(boxes))


def test_the_text_area_is_inside_the_a4_margins():
    area = pdf.text_area()
    assert round(area.left, 1) == round(15 * pdf.MM, 1)
    assert round(pdf.PAGE_HEIGHT - area.bottom, 1) == round(18 * pdf.MM, 1)
    assert area.height == area.bottom - area.top
    assert "margin: 15mm 15mm 18mm 15mm" in pdf.PDF_PAGE_CSS


def test_titles_compare_by_letters_and_digits():
    assert pdf.normalise("Settings & Configuration¶") == pdf.normalise("settings  configuration")
    assert pdf.normalise("Dashboards (2.3.0)") == "dashboards230"


def test_an_image_cut_by_a_page_edge_is_found():
    pages = [
        page(1, line(100), image(600, 840)),  # runs past the bottom: cut
        page(2, image(0, 120), line(130)),  # starts above the top: the other half
        page(3, image(100, 400)),  # whole
    ]
    found = pdf.cut_images(pages, AREA)
    assert [f.split(":")[0] for f in found] == ["page 1", "page 2"]
    assert "cut by the page edge" in found[0]


def test_content_outside_the_text_area_is_found():
    pages = [
        page(1, line(100, "inside"), line(120, "too wide", x1=590), image(200, 300, x0=10, x1=300)),
        # The footer, below the text area, is not content.
        page(2, line(820, "Footer · 1 / 2", x0=0, x1=600)),
    ]
    found = pdf.outside_area(pages, AREA)
    assert len(found) == 2
    assert '"too wide"' in found[0] and "an image" in found[1]


def test_the_page_high_background_is_not_content():
    background = pdf.Box(20, 40, 580, 795, "rect")
    assert pdf.body(page(1, background, line(100)), AREA) == [line(100)]


def heading(title, number, top, level=2):
    return pdf.Heading(title=title, level=level, page=number, top=top)


def test_a_heading_left_at_the_bottom_of_a_page_is_found():
    pages = [
        page(1, line(100), line(115), line(770, "Assigning Staff", height=14), line(788)),
        page(2, line(50), line(65)),
    ]
    found = pdf.stranded_headings([heading("Assigning Staff", 1, 768)], pages, AREA)
    assert found == [
        'page 1: the heading "Assigning Staff" is left at the bottom of the page '
        "(1 line(s) of its section follow it there)"
    ]


def test_a_heading_with_its_section_started_is_fine():
    two_lines = page(1, line(100), line(700, "Limits", height=14), line(720), line(735))
    with_image = page(2, line(100), line(500, "Sharing", height=14), image(520, 790))
    divider = page(3, line(300, "User Guide", height=30))
    headings = [
        heading("Limits", 1, 698),
        heading("Sharing", 2, 498),
        heading("User Guide", 3, 298, level=1),
        heading("Not in the PDF", 9, 0),
    ]
    assert pdf.stranded_headings(headings, [two_lines, with_image, divider], AREA) == []


def test_a_heading_over_two_lines_is_read_as_one():
    pages = [
        page(
            1,
            line(100),
            line(740, "A very long heading that", height=14),
            line(756, "wraps", height=14),
            line(774),
        )
    ]
    found = pdf.stranded_headings([heading("A very long heading that wraps", 1, 738)], pages, AREA)
    assert len(found) == 1 and "1 line(s)" in found[0]


def test_pages_ending_early_and_chapter_ends():
    pages = [
        page(1, line(100), line(780)),  # full
        page(2, line(100), line(200)),  # ends early
        page(3, line(100, "Next chapter", height=20)),
        page(4),  # empty: nothing to judge
    ]
    assert pdf.early_pages(pages, AREA) == [2, 3]
    headings = [heading("Next chapter", 3, 98, level=1)]
    assert pdf.chapter_ends(headings, pages) == {2, 4}


def test_the_contents_pages_come_from_the_link_targets_and_match_the_headings():
    destinations = {"user-guide-getting-started": 4, "admin-guide-backup-recovery": 185}
    entries = [
        {
            "label": "Getting Started",
            "heading": "Getting Started",
            "target": "user-guide-getting-started",
        },
        {
            "label": "Backup & Recovery",
            "heading": "Backup & Recovery¶",
            "target": "admin-guide-backup-recovery",
        },
        {"label": "Developer Guide", "heading": None, "target": "section-4"},
    ]
    written = pdf.toc_pages(entries, destinations)
    assert written == [4, 185, None]
    headings = [
        heading("Getting Started", 4, 50, level=1),
        # A section of another chapter with the same title, earlier: not it.
        heading("Backup & Recovery", 184, 300),
        heading("Backup & Recovery", 185, 50, level=1),
    ]
    assert pdf.toc_mismatches(entries, written, headings) == [
        'Contents: "Developer Guide" leads nowhere in the PDF'
    ]
    assert pdf.toc_mismatches(entries[:2], [4, 184], headings) == []
    assert pdf.toc_mismatches(entries[:1], [5], headings) == [
        'Contents: "Getting Started" says page 5, its heading is on 4'
    ]


def test_contents_links_must_lead_to_their_pages():
    labels = ["Getting Started", "Gantt Charts"]
    assert pdf.link_mismatches(labels, [4, 8], [4, 8]) == []
    assert pdf.link_mismatches(labels, [4, 8], [4, 9]) == [
        'Contents: the link of "Gantt Charts" leads to page 9, not to page 8'
    ]
    assert pdf.link_mismatches(labels, [4, 8], [4]) == ["Contents: 1 links for 2 entries"]


def test_an_implausibly_small_pdf_is_refused():
    assert pdf.size_problems(200, 9_000_000, 40, 500_000) == []
    assert "implausibly small" in pdf.size_problems(3, 9_000_000, 40, 500_000)[0]
    assert pdf.size_problems(200, 1_000, 40, 500_000)


def test_images_are_numbered_in_reading_order():
    pages = [page(1, image(300, 400), image(100, 200)), page(2, image(50, 150))]
    order = pdf.image_order(pages)
    assert [(number, box.top) for number, box in order] == [(1, 100), (1, 300), (2, 50)]


def test_a_screenshot_that_left_a_page_half_blank_is_shrunk_to_fit():
    # Page 1 ends at y=420 (380 pt blank); page 2 starts with a heading, its
    # introduction and a 330 pt screenshot: shrunk so that the group fits.
    pages = [
        page(1, line(100), line(410)),
        page(2, line(40, "Heading", height=14), line(70), image(90, 420), line(430)),
    ]
    fits = pdf.image_fits(pages, AREA, skip=set())
    assert list(fits) == [0]
    blank = AREA.bottom - 420 - 8
    excess = (420 - AREA.top) - blank + pdf.FIT_MARGIN
    assert fits[0] == pytest.approx(330 - excess)
    # A chapter end is left alone, and so is a picture that would need
    # shrinking by more than the limit, or that something long precedes.
    assert pdf.image_fits(pages, AREA, skip={1}) == {}
    assert pdf.image_fits(pages, AREA, skip=set(), max_shrink=0.01) == {}
    far = [page(1, line(100), line(410)), page(2, line(40), line(300), image(320, 600))]
    assert pdf.image_fits(far, AREA, skip=set()) == {}
    no_image = [page(1, line(100), line(410)), page(2, line(40), line(300))]
    assert pdf.image_fits(no_image, AREA, skip=set()) == {}


def test_the_footer_and_the_page_count():
    footer = pdf.footer("2.6.0")
    assert "Milestone Planner — User and Admin Manual · 2.6.0" in footer
    assert 'class="pageNumber"' in footer and 'class="totalPages"' in footer
    assert "&lt;" in pdf.footer("<b>")
    assert pdf.page_count(b"<< /Type /Pages >> << /Type /Page >> << /Type/Page >>") == 2
