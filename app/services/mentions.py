"""
@-mention wire format for card comments.

Mirrors the token half of frontend/src/utils/mentions.ts -- change one, change
both. The shared string table is asserted on both sides (tests/test_mentions.py
and src/utils/__tests__/mentions.test.ts).

A comment body stores mentions as `@[Alice Anderson](7)`. The body is the
durable record: it is what renders in the thread, what lands in the site export
and what a future edit UI round-trips. Mention targeting is therefore derived
from the body rather than from a separate client-supplied list, so the pills a
reader sees and the people who were notified cannot drift apart.

A comment written before mentions existed contains no tokens, so both functions
here are no-ops on it.
"""

import re

# Names are length-bounded so a pathological body cannot blow up the match.
MENTION_TOKEN_RE = re.compile(r"@\[([^\]\n]{1,120})\]\((\d+)\)")


def parse_mention_ids(body: str) -> list[int]:
    """User ids referenced by `@[Name](id)` tokens, in order, deduplicated."""
    if not body:
        return []

    ids: list[int] = []
    seen: set[int] = set()
    for match in MENTION_TOKEN_RE.finditer(body):
        try:
            user_id = int(match.group(2))
        except ValueError:  # pragma: no cover - the pattern only matches digits
            continue
        if user_id not in seen:
            seen.add(user_id)
            ids.append(user_id)
    return ids


def strip_mention_tokens(body: str) -> str:
    """`@[Alice Anderson](7)` -> `@Alice Anderson`, for plain-text previews.

    Always strip before truncating a preview: truncating first can cut a token
    in half and leave `@[Alice And` in the notification.
    """
    if not body:
        return body
    return MENTION_TOKEN_RE.sub(lambda m: f"@{m.group(1)}", body)
