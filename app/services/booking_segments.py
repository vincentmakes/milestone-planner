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
carry the same case table -- change one, change both.

``place_booking`` (2.0.0) places a **dateless second booking** of a person on
a card: the largest free stretch of the card (ties -> the earliest), else the
halving of the one booking covering the whole card, else no room. It is
**server-only, with no client mirror on purpose**: creates are blocked during
What-If and the client never predicts a placement -- it reloads after the
POST, whose response carries the result. Do not add a mirror "for symmetry".

Import-light: dates only, no models.
"""

from datetime import date, timedelta

Segment = tuple[date, date]
# (new_start, new_end, the shortened dates of the full-span row, or None)
Placement = tuple[date, date, Segment | None]


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


def place_booking(card_start: date, card_end: date, existing: list[Segment]) -> Placement | None:
    """
    Where a dateless new booking of a person goes on a card, given the
    **effective** spans of the person's bookings there (a linked row spans
    the card), in any order. Each span is clipped to the card and a span
    wholly outside it (legacy data) is dropped, so the result never depends
    on row order or on stale rows.

    1. Free days left (inclusive days; adjacent days do not overlap) -> the
       **largest** free stretch, ties -> the earliest; the new booking is that
       whole stretch (a dated segment, even when it is the whole card), and
       nothing is shortened.
    2. No free day, **exactly one** span left and it covers the whole card of
       at least 2 days -> split: the existing booking keeps the first half
       (the longer one on an odd length), the new one gets the rest.
    3. Otherwise ``None``: several rows covering the card (a full-span row
       plus an overlapping leftover of an earlier shrink included), or a
       one-day card already booked.

    No spans at all returns the whole card; callers book a person without a
    row on the card linked instead.
    """
    clipped = sorted(
        (max(start, card_start), min(end, card_end))
        for start, end in existing
        if segments_overlap(start, end, card_start, card_end)
    )
    best: Segment | None = None
    cursor = card_start
    for start, end in clipped:
        if start > cursor:
            best = _larger(best, (cursor, start - timedelta(days=1)))
        cursor = max(cursor, end + timedelta(days=1))
    if cursor <= card_end:
        best = _larger(best, (cursor, card_end))
    if best is not None:
        return (best[0], best[1], None)

    days = (card_end - card_start).days + 1
    if len(clipped) == 1 and days >= 2:
        half = (days + 1) // 2
        shrink_end = card_start + timedelta(days=half - 1)
        return (shrink_end + timedelta(days=1), card_end, (card_start, shrink_end))
    return None


def _larger(best: Segment | None, gap: Segment) -> Segment:
    """The longer of two free stretches; on a tie the one found first (earlier)."""
    if best is None or (gap[1] - gap[0]) > (best[1] - best[0]):
        return gap
    return best
