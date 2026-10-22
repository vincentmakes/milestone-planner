"""
Unlinked booking segments: the shared date rule (1.17.0).

A phase / subphase staff booking is either *linked* (no own dates: it follows
its card) or an *unlinked segment* with its own ``start_date`` / ``end_date``
inside the card. A person may hold several non-overlapping segments on one
card. When the card's dates change, its segments are fitted to the new dates
with ``fit_segments_to_card``:

  - the card moved with the same duration -> every segment moves with it;
  - otherwise each segment is clamped into the card; a segment left fully
    outside is placed against the nearest edge, keeping its length (capped by
    the card), so it never ends before it starts nor outgrows the card;
  - unchanged card dates -> the segments are returned as they are.

Mirrored byte-for-byte by the frontend (``frontend/src/utils/bookingSegments.ts``):
``tests/test_booking_segments.py`` and ``src/utils/__tests__/bookingSegmentsMirror.test.ts``
carry the same case table -- change one, change both. Import-light: dates
only, no models.
"""

from datetime import date, timedelta

Segment = tuple[date, date]


def effective_dates(
    own_start: date | None, own_end: date | None, card_start: date, card_end: date
) -> tuple[date, date, bool]:
    """``(start, end, linked)`` of a booking: a linked one (no own dates) spans its card."""
    if own_start is None or own_end is None:
        return card_start, card_end, True
    return own_start, own_end, False


def segments_overlap(a_start: date, a_end: date, b_start: date, b_end: date) -> bool:
    """Inclusive-day overlap: segments sharing at least one day overlap."""
    return a_start <= b_end and b_start <= a_end


def _fit_one(seg_start: date, seg_end: date, card_start: date, card_end: date) -> Segment:
    start = max(seg_start, card_start)
    end = min(seg_end, card_end)
    if start <= end:
        return (start, end)
    # Fully outside the card: against the nearest edge, original length
    # capped by the card.
    length = (seg_end - seg_start).days + 1
    if seg_end < card_start:
        return (card_start, min(card_start + timedelta(days=length - 1), card_end))
    return (max(card_end - timedelta(days=length - 1), card_start), card_end)


def fit_segments_to_card(
    old_start: date,
    old_end: date,
    new_start: date,
    new_end: date,
    segments: list[Segment],
) -> list[Segment]:
    """The segments of a card whose dates go from ``old_*`` to ``new_*``, in input order."""
    if old_start == new_start and old_end == new_end:
        return list(segments)
    if new_start != old_start and (new_end - new_start) == (old_end - old_start):
        shift = new_start - old_start
        return [(start + shift, end + shift) for start, end in segments]
    return [_fit_one(start, end, new_start, new_end) for start, end in segments]
