"""
The shared date rule of unlinked booking segments (app/services/booking_segments.py).

FIT_CASES and OVERLAP_CASES are the contract: the frontend mirror
(frontend/src/utils/bookingSegments.ts) runs the SAME case lists in
frontend/src/utils/__tests__/bookingSegmentsMirror.test.ts. Change one, change
both -- keep them plain tuples of ISO day strings so they copy over verbatim.
"""

from datetime import date

import pytest

from app.services.booking_segments import fit_segments_to_card, segments_overlap

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
