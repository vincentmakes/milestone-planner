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


def test_the_footer_is_in_the_page_margin_and_left_off_the_cover():
    css = pdf.page_css("2.6.0")
    assert '@bottom-left { content: "Milestone Planner — User and Admin Manual · 2.6.0"' in css
    assert 'counter(page) " / " counter(pages)' in css
    assert (
        "@page :first { @bottom-left { content: none; } @bottom-right { content: none; } }" in css
    )
    # A quote in the label cannot end the CSS string.
    assert '\\"' in pdf.page_css('2"6')
    assert pdf.page_count(b"<< /Type /Pages >> << /Type /Page >> << /Type/Page >>") == 2


def test_lines_are_counted_as_a_reader_sees_them():
    # Two pieces on one baseline are one line; an image is no line.
    boxes = [line(100), line(102, "same line"), line(120), image(140, 200)]
    assert pdf.visual_lines(boxes) == 2
    assert pdf.visual_lines([]) == 0


def test_a_chapter_ending_on_a_scrap_is_found():
    headings = [
        heading("Staff Management", 1, 50, level=1),
        heading("Real-Time Collaboration", 4, 50, level=1),
        heading("Divider", 6, 300, level=1),
    ]
    pages = [
        page(1, line(60, "Staff Management", height=20), line(100), line(780)),
        page(2, line(50), line(780)),
        page(3, line(50, "is not available yet.")),  # one line: a scrap
        page(4, line(60, "Real-Time Collaboration", height=20), line(780)),
        page(5, line(50), image(80, 300)),  # an image: a proper last page
        page(6, line(300, "Divider", height=30)),  # one page: not a tail
    ]
    assert pdf.chapter_spans(headings, pages) == [
        ("Staff Management", 1, 3),
        ("Real-Time Collaboration", 4, 5),
        ("Divider", 6, 6),
    ]
    tails = pdf.chapter_tails(headings, pages, AREA)
    assert tails == [("Staff Management", 3, 1)]
    message = pdf.tail_problems(tails)[0]
    assert message.startswith('page 3: the last page of "Staff Management" holds only 1 line(s)')
    assert "{.print-page-break}" in message
    # The last rows of a table cut by the page before are a scrap too; a
    # whole table (a box a quarter page tall) is a proper last page.
    rows = page(3, pdf.Box(50, 40, 500, 110, "rect"), line(50, "Variable"), line(70), line(90))
    assert pdf.chapter_tails(headings, [*pages[:2], rows, *pages[3:]], AREA)[0][1:] == (3, 3)
    table = page(3, pdf.Box(50, 40, 500, 300, "rect"), line(50), line(70), line(90))
    assert pdf.chapter_tails(headings, [*pages[:2], table, *pages[3:]], AREA) == []
    # Six lines are enough.
    six = page(3, *(line(50 + 15 * i) for i in range(6)))
    assert pdf.chapter_tails(headings, [*pages[:2], six, *pages[3:]], AREA) == []


def test_a_page_ending_early_inside_a_chapter_names_what_moved():
    headings = [
        heading("Gantt Charts", 1, 50, level=1),
        heading("Context Menu", 3, 42),
        heading("Kanban", 5, 50, level=1),
    ]
    pages = [
        page(1, line(60, "Gantt Charts", height=20), line(780)),
        page(2, line(50), line(400)),  # ends early: the section moved
        page(3, line(44, "Context Menu", height=14), line(780)),
        page(4, line(50), line(300)),  # the chapter's last page: allowed
        page(5, line(60, "Kanban", height=20), line(780)),
        page(6, line(50), line(780)),
        page(7, line(50), line(300)),
    ]
    found = pdf.mid_chapter_gaps(headings, pages, AREA)
    assert found == [
        'page 2: ends more than a third early inside its chapter; the section "Context Menu" '
        "moved to page 3 (shrink its screenshot, or mark a block {.print-keep-with-next} "
        "or {.print-page-break})"
    ]
    # No heading at the top of the next page: its first line is named.
    pages[2] = page(3, line(44, "A paragraph that did not fit"), line(780))
    assert (
        '"A paragraph that did not fit" moved to page 3'
        in pdf.mid_chapter_gaps(headings[:1] + headings[2:], pages, AREA)[0]
    )


def test_a_stranded_heading_low_on_its_page_moves_to_the_next():
    headings = [heading("Low", 1, 768), heading("High", 2, 300)]
    pages = [
        page(1, line(100), line(770, "Low", height=14), line(788)),
        page(2, line(100), line(302, "High", height=14), line(320)),
    ]
    assert [i for i, _h, _l in pdf.stranded(headings, pages, AREA)] == [0, 1]
    # Only the low one: moving the high one would leave its page too empty.
    assert pdf.stranded_breaks(headings, pages, AREA) == [0]


def test_a_one_line_introduction_followed_by_a_subsection_is_not_stranded():
    headings = [heading("Section", 1, 768, level=2), heading("Subsection", 2, 42, level=3)]
    pages = [
        page(1, line(100), line(770, "Section", height=14), line(788)),
        page(2, line(44, "Subsection", height=14), line(70), line(85)),
    ]
    assert pdf.stranded(headings, pages, AREA) == []
    # Without the subsection there, the one line is too little.
    assert len(pdf.stranded(headings[:1], pages, AREA)) == 1


def test_a_chapter_tail_is_absorbed_by_a_screenshot_then_tightening_then_a_break():
    headings = [heading("Chapter", 1, 50, level=1), heading("Late section", 2, 600)]
    pages = [
        page(1, line(60, "Chapter", height=20), image(100, 500), line(780)),
        page(2, line(50), line(602, "Late section", height=14), line(620), line(780)),
        page(3, line(50, "the scrap")),
    ]
    tails = [("Chapter", 3, 1)]
    natural = {0: 400.0}
    # 1. The screenshot can give up the scrap's height.
    shrinks, tighten, breaks, texts = pdf.tail_fixes(headings, pages, AREA, tails, natural, {})
    need = (60 - AREA.top) + pdf.FIT_MARGIN
    assert shrinks == {0: pytest.approx(400 - need)} and not (tighten or breaks or texts)
    # 2. Not within the shrink limit: the chapter is tightened.
    shrinks, tighten, breaks, texts = pdf.tail_fixes(
        headings, pages, AREA, tails, natural, {}, max_shrink=0.01
    )
    assert shrinks == {} and tighten == [0] and breaks == [] and texts == []
    # 3. Tightened already: the late section starts the last page.
    shrinks, tighten, breaks, texts = pdf.tail_fixes(
        headings, pages, AREA, tails, natural, {}, tightened={0}, max_shrink=0.01
    )
    assert tighten == [] and breaks == [1] and texts == []
    # 4. No heading low enough: the block a low line starts, never the line under a heading.
    # ("Above" sits just over the band, so the line under it is skipped.)
    plain = [heading("Chapter", 1, 50, level=1), heading("Above", 2, 560)]
    pages[1] = page(
        2,
        line(50),
        line(562, "Above", height=14),
        line(580, "First line of Above"),
        line(640, "A late paragraph"),
        line(780),
    )
    _s, _t, breaks, texts = pdf.tail_fixes(
        plain, pages, AREA, tails, natural, {}, tightened={0}, max_shrink=0.01
    )
    assert breaks == [] and (0, "A late paragraph") in texts
    assert (0, "First line of Above") not in texts


def test_the_cover_has_no_footer_and_a_modest_logo():
    assert pdf.cover_problems([], AREA) == []
    good = page(1, image(40, 40 + 13 * pdf.MM), line(300, "Milestone Planner", height=30))
    assert pdf.cover_problems([good], AREA) == []
    bad = page(1, image(40, 300), line(820, "Milestone Planner — User and Admin Manual"))
    found = pdf.cover_problems([bad], AREA)
    assert found[0] == "page 1: the cover carries the running footer"
    assert "mm high (at most 20 mm)" in found[1]


def test_a_document_shrunk_to_fit_is_refused():
    assert pdf.scale_problems(10.2, 10.2) == []
    assert pdf.scale_problems(10.2, None) == []
    assert pdf.scale_problems(0, 9.0) == []
    found = pdf.scale_problems(10.2, 9.7)
    assert found and "9.70 pt instead of 10.20 pt" in found[0]


HOOK = Path(__file__).resolve().parents[1] / "docs" / "hooks" / "manual_version.py"
_hook_spec = importlib.util.spec_from_file_location("manual_version", HOOK)
assert _hook_spec and _hook_spec.loader
hook = importlib.util.module_from_spec(_hook_spec)
_hook_spec.loader.exec_module(hook)


def test_the_cover_reads_the_version_month_and_sentence_from_the_build(tmp_path, monkeypatch):
    from datetime import datetime

    assert hook.build_month(datetime(2026, 11, 3)) == "November 2026"
    monkeypatch.setenv("SOURCE_DATE_EPOCH", "1767225600")  # 2026-01-01 UTC
    assert hook.build_month() == "January 2026"
    assert (
        hook.cover_description("Milestone Planner — plan R&D projects and people.")
        == "Using and running Milestone Planner: plan R&D projects and people."
    )
    assert hook.cover_description("") == ""
    (tmp_path / "VERSION").write_text("2.6.0\n", encoding="utf-8")

    class Config:
        config_file_path = str(tmp_path / "mkdocs.yml")
        site_description = "Docs — the manual"
        extra: dict = {}

    config = hook.on_config(Config())
    assert config.extra == {
        "version": "2.6.0",
        "build_month": "January 2026",
        "cover_description": "Using and running Milestone Planner: the manual.",
    }
