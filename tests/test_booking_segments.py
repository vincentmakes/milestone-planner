"""
The shared date rule of unlinked booking segments (app/services/booking_segments.py).

FIT_CASES and OVERLAP_CASES are the contract: the frontend mirror
(frontend/src/utils/bookingSegments.ts) runs the SAME case lists in
frontend/src/utils/__tests__/bookingSegmentsMirror.test.ts. Change one, change
both -- keep them plain tuples of ISO day strings so they copy over verbatim.

PLACE_CASES (``place_booking``, the automatic placement of a dateless second
booking) are server-only: the client never predicts a placement, so they have
no mirror.
"""

from datetime import date, timedelta

import pytest

from app.services.booking_segments import fit_segments_to_card, place_booking, segments_overlap

# (name, old_start, old_end, new_start, new_end, segments, expected)
# The card is 2026-03-02 .. 2026-03-13 (12 days) unless the case says otherwise.
FIT_CASES: list[tuple[str, str, str, str, str, list[tuple[str, str]], list[tuple[str, str]]]] = [
    (
        "identity: unchanged card dates",
        "2026-03-02", "2026-03-13", "2026-03-02", "2026-03-13",
        [("2026-03-03", "2026-03-05"), ("2026-03-09", "2026-03-11")],
        [("2026-03-03", "2026-03-05"), ("2026-03-09", "2026-03-11")],
    ),
    (
        "translate forward: same duration, every segment moves",
        "2026-03-02", "2026-03-13", "2026-03-09", "2026-03-20",
        [("2026-03-03", "2026-03-05"), ("2026-03-09", "2026-03-11")],
        [("2026-03-10", "2026-03-12"), ("2026-03-16", "2026-03-18")],
    ),
    (
        "translate backward across a month boundary",
        "2026-03-02", "2026-03-13", "2026-02-23", "2026-03-06",
        [("2026-03-03", "2026-03-05"), ("2026-03-09", "2026-03-11")],
        [("2026-02-24", "2026-02-26"), ("2026-03-02", "2026-03-04")],
    ),
    (
        "shrink right: the segment past the new end is cut",
        "2026-03-02", "2026-03-13", "2026-03-02", "2026-03-10",
        [("2026-03-03", "2026-03-05"), ("2026-03-09", "2026-03-11")],
        [("2026-03-03", "2026-03-05"), ("2026-03-09", "2026-03-10")],
    ),
    (
        "shrink left: the segment before the new start is cut",
        "2026-03-02", "2026-03-13", "2026-03-04", "2026-03-13",
        [("2026-03-03", "2026-03-05"), ("2026-03-09", "2026-03-11")],
        [("2026-03-04", "2026-03-05"), ("2026-03-09", "2026-03-11")],
    ),
    (
        "grow on both sides: segments stay where they are",
        "2026-03-02", "2026-03-13", "2026-02-27", "2026-03-16",
        [("2026-03-03", "2026-03-05"), ("2026-03-09", "2026-03-11")],
        [("2026-03-03", "2026-03-05"), ("2026-03-09", "2026-03-11")],
    ),
    (
        "grow the end only: segments stay where they are",
        "2026-03-02", "2026-03-13", "2026-03-02", "2026-03-20",
        [("2026-03-09", "2026-03-11")],
        [("2026-03-09", "2026-03-11")],
    ),
    (
        "move and resize at once: clamped, not shifted",
        "2026-03-02", "2026-03-13", "2026-03-04", "2026-03-10",
        [("2026-03-03", "2026-03-05"), ("2026-03-09", "2026-03-11")],
        [("2026-03-04", "2026-03-05"), ("2026-03-09", "2026-03-10")],
    ),
    (
        "segment fully before the new start: against the start, length kept",
        "2026-03-02", "2026-03-13", "2026-03-09", "2026-03-13",
        [("2026-03-03", "2026-03-05")],
        [("2026-03-09", "2026-03-11")],
    ),
    (
        "segment fully after the new end: against the end, length kept",
        "2026-03-02", "2026-03-13", "2026-03-02", "2026-03-06",
        [("2026-03-09", "2026-03-11")],
        [("2026-03-04", "2026-03-06")],
    ),
    (
        "segment fully outside and longer than the card: capped to the card",
        "2026-03-02", "2026-03-13", "2026-03-02", "2026-03-03",
        [("2026-03-09", "2026-03-12")],
        [("2026-03-02", "2026-03-03")],
    ),
    (
        "segment fully before and longer than the card: capped to the card",
        "2026-03-02", "2026-03-13", "2026-03-12", "2026-03-13",
        [("2026-03-02", "2026-03-06")],
        [("2026-03-12", "2026-03-13")],
    ),
    (
        "segment straddling both new edges: cut to the card",
        "2026-03-02", "2026-03-13", "2026-03-04", "2026-03-06",
        [("2026-03-02", "2026-03-13")],
        [("2026-03-04", "2026-03-06")],
    ),
    (
        "one-day card: every segment becomes that day",
        "2026-03-02", "2026-03-13", "2026-03-05", "2026-03-05",
        [("2026-03-03", "2026-03-05"), ("2026-03-09", "2026-03-11")],
        [("2026-03-05", "2026-03-05"), ("2026-03-05", "2026-03-05")],
    ),
    (
        "one-day card moved: its one-day segment moves with it",
        "2026-03-05", "2026-03-05", "2026-03-08", "2026-03-08",
        [("2026-03-05", "2026-03-05")],
        [("2026-03-08", "2026-03-08")],
    ),
    (
        "no segments",
        "2026-03-02", "2026-03-13", "2026-03-09", "2026-03-20",
        [],
        [],
    ),
]  # fmt: skip

# (name, a_start, a_end, b_start, b_end, overlap) -- inclusive days.
OVERLAP_CASES: list[tuple[str, str, str, str, str, bool]] = [
    ("adjacent days do not overlap", "2026-03-02", "2026-03-05", "2026-03-06", "2026-03-09", False),
    ("adjacent days, other order", "2026-03-06", "2026-03-09", "2026-03-02", "2026-03-05", False),
    ("touching on one day overlaps", "2026-03-02", "2026-03-05", "2026-03-05", "2026-03-09", True),
    ("touching, other order", "2026-03-05", "2026-03-09", "2026-03-02", "2026-03-05", True),
    ("contained", "2026-03-02", "2026-03-13", "2026-03-05", "2026-03-06", True),
    ("partial", "2026-03-02", "2026-03-06", "2026-03-04", "2026-03-09", True),
    ("same single day", "2026-03-05", "2026-03-05", "2026-03-05", "2026-03-05", True),
    ("disjoint", "2026-03-02", "2026-03-03", "2026-03-10", "2026-03-12", False),
]  # fmt: skip


# (name, card_start, card_end, existing spans, expected (new_start, new_end,
# shrink or None) or None = no room). The effective span of a linked row is
# the card's. Server-only: no frontend mirror.
PLACE_CASES: list[
    tuple[
        str,
        str,
        str,
        list[tuple[str, str]],
        tuple[str, str, tuple[str, str] | None] | None,
    ]
] = [
    (
        "one linked row, 12 days: split 6 / 6",
        "2026-03-02", "2026-03-13",
        [("2026-03-02", "2026-03-13")],
        ("2026-03-08", "2026-03-13", ("2026-03-02", "2026-03-07")),
    ),
    (
        "one linked row, 10 days: split 5 / 5",
        "2026-03-02", "2026-03-11",
        [("2026-03-02", "2026-03-11")],
        ("2026-03-07", "2026-03-11", ("2026-03-02", "2026-03-06")),
    ),
    (
        "one linked row, 11 days: the existing booking keeps the longer half (6 / 5)",
        "2026-03-02", "2026-03-12",
        [("2026-03-02", "2026-03-12")],
        ("2026-03-08", "2026-03-12", ("2026-03-02", "2026-03-07")),
    ),
    (
        "one linked row, 2 days: split 1 / 1",
        "2026-03-02", "2026-03-03",
        [("2026-03-02", "2026-03-03")],
        ("2026-03-03", "2026-03-03", ("2026-03-02", "2026-03-02")),
    ),
    (
        "one-day card already booked: no room",
        "2026-03-05", "2026-03-05",
        [("2026-03-05", "2026-03-05")],
        None,
    ),
    (
        "one unlinked row spanning the card: split like a linked one",
        "2026-03-02", "2026-03-11",
        [("2026-03-02", "2026-03-11")],
        ("2026-03-07", "2026-03-11", ("2026-03-02", "2026-03-06")),
    ),
    (
        "one row reaching past both edges (legacy): clipped, then split",
        "2026-03-02", "2026-03-11",
        [("2026-02-20", "2026-03-20")],
        ("2026-03-07", "2026-03-11", ("2026-03-02", "2026-03-06")),
    ),
    (
        "one unlinked row at the start: the rest of the card",
        "2026-03-02", "2026-03-13",
        [("2026-03-02", "2026-03-04")],
        ("2026-03-05", "2026-03-13", None),
    ),
    (
        "one unlinked row at the end: the start of the card",
        "2026-03-02", "2026-03-13",
        [("2026-03-10", "2026-03-13")],
        ("2026-03-02", "2026-03-09", None),
    ),
    (
        "gap before is the largest",
        "2026-03-02", "2026-03-13",
        [("2026-03-07", "2026-03-08"), ("2026-03-10", "2026-03-13")],
        ("2026-03-02", "2026-03-06", None),
    ),
    (
        "gap between is the largest",
        "2026-03-02", "2026-03-13",
        [("2026-03-02", "2026-03-03"), ("2026-03-10", "2026-03-12")],
        ("2026-03-04", "2026-03-09", None),
    ),
    (
        "gap after is the largest",
        "2026-03-02", "2026-03-13",
        [("2026-03-03", "2026-03-04"), ("2026-03-06", "2026-03-07")],
        ("2026-03-08", "2026-03-13", None),
    ),
    (
        "equal gaps: the earliest wins",
        "2026-03-02", "2026-03-13",
        [("2026-03-05", "2026-03-06"), ("2026-03-10", "2026-03-11")],
        ("2026-03-02", "2026-03-04", None),
    ),
    (
        "reversed input order gives the same gap",
        "2026-03-02", "2026-03-13",
        [("2026-03-10", "2026-03-12"), ("2026-03-02", "2026-03-03")],
        ("2026-03-04", "2026-03-09", None),
    ),
    (
        "a one-day gap is still room",
        "2026-03-02", "2026-03-13",
        [("2026-03-02", "2026-03-06"), ("2026-03-08", "2026-03-13")],
        ("2026-03-07", "2026-03-07", None),
    ),
    (
        "a row partly outside the card is clipped before the gaps are found",
        "2026-03-02", "2026-03-13",
        [("2026-02-25", "2026-03-04")],
        ("2026-03-05", "2026-03-13", None),
    ),
    (
        "a row wholly outside the card is ignored",
        "2026-03-02", "2026-03-13",
        [("2026-03-20", "2026-03-25"), ("2026-03-02", "2026-03-04")],
        ("2026-03-05", "2026-03-13", None),
    ),
    (
        "only rows wholly outside the card: the whole card is free",
        "2026-03-02", "2026-03-13",
        [("2026-02-01", "2026-02-10")],
        ("2026-03-02", "2026-03-13", None),
    ),
    (
        "two rows covering the whole card: no room",
        "2026-03-02", "2026-03-13",
        [("2026-03-02", "2026-03-07"), ("2026-03-08", "2026-03-13")],
        None,
    ),
    (
        "a full-span row plus an overlapping leftover: no room (never split)",
        "2026-03-02", "2026-03-13",
        [("2026-03-02", "2026-03-13"), ("2026-03-12", "2026-03-13")],
        None,
    ),
    (
        "overlapping rows (post-shrink residue) covering everything: no room",
        "2026-03-02", "2026-03-13",
        [("2026-03-02", "2026-03-09"), ("2026-03-06", "2026-03-13"), ("2026-03-12", "2026-03-13")],
        None,
    ),
    (
        "overlapping rows leaving a gap: the gap",
        "2026-03-02", "2026-03-13",
        [("2026-03-02", "2026-03-06"), ("2026-03-04", "2026-03-08"), ("2026-03-12", "2026-03-13")],
        ("2026-03-09", "2026-03-11", None),
    ),
    (
        "nested rows: the gap after the outer one",
        "2026-03-02", "2026-03-13",
        [("2026-03-02", "2026-03-10"), ("2026-03-03", "2026-03-04")],
        ("2026-03-11", "2026-03-13", None),
    ),
]  # fmt: skip


def _d(value: str) -> date:
    return date.fromisoformat(value)


@pytest.mark.parametrize(
    ("name", "old_start", "old_end", "new_start", "new_end", "segments", "expected"),
    FIT_CASES,
    ids=[case[0] for case in FIT_CASES],
)
def test_fit_segments_to_card(name, old_start, old_end, new_start, new_end, segments, expected):
    result = fit_segments_to_card(
        _d(old_start),
        _d(old_end),
        _d(new_start),
        _d(new_end),
        [(_d(s), _d(e)) for s, e in segments],
    )
    assert result == [(_d(s), _d(e)) for s, e in expected]


@pytest.mark.parametrize(
    ("name", "old_start", "old_end", "new_start", "new_end", "segments", "expected"),
    FIT_CASES,
    ids=[case[0] for case in FIT_CASES],
)
def test_fitted_segments_are_valid_and_inside_the_card(
    name, old_start, old_end, new_start, new_end, segments, expected
):
    card_start, card_end = _d(new_start), _d(new_end)
    for start, end in fit_segments_to_card(
        _d(old_start), _d(old_end), card_start, card_end, [(_d(s), _d(e)) for s, e in segments]
    ):
        assert card_start <= start <= end <= card_end


def test_identity_returns_a_new_list():
    segments = [(_d("2026-03-03"), _d("2026-03-05"))]
    result = fit_segments_to_card(
        _d("2026-03-02"), _d("2026-03-13"), _d("2026-03-02"), _d("2026-03-13"), segments
    )
    assert result == segments and result is not segments


@pytest.mark.parametrize(
    ("name", "a_start", "a_end", "b_start", "b_end", "overlap"),
    OVERLAP_CASES,
    ids=[case[0] for case in OVERLAP_CASES],
)
def test_segments_overlap(name, a_start, a_end, b_start, b_end, overlap):
    assert segments_overlap(_d(a_start), _d(a_end), _d(b_start), _d(b_end)) is overlap


@pytest.mark.parametrize(
    ("name", "card_start", "card_end", "existing", "expected"),
    PLACE_CASES,
    ids=[case[0] for case in PLACE_CASES],
)
def test_place_booking(name, card_start, card_end, existing, expected):
    result = place_booking(_d(card_start), _d(card_end), [(_d(s), _d(e)) for s, e in existing])
    if expected is None:
        assert result is None
        return
    new_start, new_end, shrink = expected
    assert result == (
        _d(new_start),
        _d(new_end),
        None if shrink is None else (_d(shrink[0]), _d(shrink[1])),
    )


@pytest.mark.parametrize(
    ("name", "card_start", "card_end", "existing", "expected"),
    [case for case in PLACE_CASES if case[4] is not None],
    ids=[case[0] for case in PLACE_CASES if case[4] is not None],
)
def test_a_placement_lies_inside_the_card_and_overlaps_nothing_left(
    name, card_start, card_end, existing, expected
):
    start, end = _d(card_start), _d(card_end)
    spans = [(_d(s), _d(e)) for s, e in existing]
    result = place_booking(start, end, spans)
    assert result is not None
    new_start, new_end, shrink = result
    assert start <= new_start <= new_end <= end
    if shrink is not None:
        # The split leaves the shortened row and the new booking side by side.
        spans = [shrink]
        assert shrink[0] == start and shrink[1] + timedelta(days=1) == new_start
    assert not any(segments_overlap(new_start, new_end, s, e) for s, e in spans)


def test_place_booking_with_no_rows_is_the_whole_card():
    # Not a case the callers use (no row = a linked booking), but well defined.
    assert place_booking(_d("2026-03-02"), _d("2026-03-13"), []) == (
        _d("2026-03-02"),
        _d("2026-03-13"),
        None,
    )
