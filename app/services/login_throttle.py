"""
Failed-login throttling for the tenant and admin-portal login routes.

Two sliding windows of failed attempts are kept:

* per ``(scope, client ip, e-mail)``: once ``MAX_FAILURES`` failures fall
  inside ``WINDOW_SECONDS``, further attempts for that key are refused with
  HTTP 429 (without checking the password) until the oldest failure ages out.
  A successful login clears the key. **The lockout is per (ip, e-mail), not
  per account**: the same e-mail keeps working from any other address.
* per client ip, across every scope and e-mail: ``MAX_FAILURES_PER_IP``
  failures in the window → 429 for every login from that address, which caps
  password spraying over many e-mails. A successful login does not clear it
  (one valid account must not reset the budget for guessing the others).
  This bucket only applies to *public* addresses: a private, loopback,
  link-local or shared (CGNAT) address may be a reverse proxy or NAT in front
  of many users, and a per-ip limit there would let anyone lock out every
  login with a burst of bad passwords.

The client ip is ``request.client.host``. Behind a reverse proxy that is the
proxy's address unless uvicorn is told to trust its ``X-Forwarded-For``
(``FORWARDED_ALLOW_IPS``, see the installation guide) -- without it every
client shares one ``(ip, e-mail)`` key, so ten bad passwords from anyone lock
that e-mail out for everyone.

The state is **in-memory and per process**: with several uvicorn workers each
keeps its own counters, so the effective limits are per worker. That is
enough to turn online password guessing from "unbounded" into "a few dozen
tries per quarter hour"; it is not a distributed rate limiter.
"""

import ipaddress
import time
from collections import deque
from typing import TypeVar

from fastapi import HTTPException, Request, status

MAX_FAILURES = 10
MAX_FAILURES_PER_IP = 100
WINDOW_SECONDS = 15 * 60
# Hard cap on tracked keys (per bucket) so a flood of random e-mails cannot
# grow memory without bound; the oldest keys are dropped first.
MAX_TRACKED_KEYS = 10_000

K = TypeVar("K")

_failures: dict[tuple[str, str, str], deque[float]] = {}
_ip_failures: dict[str, deque[float]] = {}


def _client_ip(request: Request) -> str:
    return request.client.host if request.client else "unknown"


def _key(scope: str, request: Request, email: str) -> tuple[str, str, str]:
    return (scope, _client_ip(request), (email or "").strip().lower())


def _ip_may_be_shared(ip: str) -> bool:
    """True unless ``ip`` is a public address (proxy / NAT / unparseable)."""
    try:
        addr = ipaddress.ip_address(ip)
    except ValueError:
        return True
    if isinstance(addr, ipaddress.IPv6Address) and addr.ipv4_mapped is not None:
        addr = addr.ipv4_mapped
    return not addr.is_global


def _prune(entries: deque[float], now: float) -> None:
    while entries and now - entries[0] >= WINDOW_SECONDS:
        entries.popleft()


def _recent(bucket: dict[K, deque[float]], key: K, now: float) -> int:
    """Number of failures for ``key`` still inside the window."""
    entries = bucket.get(key)
    if not entries:
        return 0
    _prune(entries, now)
    if not entries:
        bucket.pop(key, None)
        return 0
    return len(entries)


def _record(bucket: dict[K, deque[float]], key: K, now: float) -> None:
    entries = bucket.get(key)
    if entries is None:
        if len(bucket) >= MAX_TRACKED_KEYS:
            # dicts keep insertion order: drop the oldest tracked key
            bucket.pop(next(iter(bucket)))
        entries = deque()
        bucket[key] = entries
    _prune(entries, now)
    entries.append(now)


def _too_many(oldest: float, now: float) -> HTTPException:
    retry_after = max(1, int(WINDOW_SECONDS - (now - oldest)) + 1)
    return HTTPException(
        status_code=status.HTTP_429_TOO_MANY_REQUESTS,
        detail="Too many failed sign-in attempts. Please try again later.",
        headers={"Retry-After": str(retry_after)},
    )


def check_login_allowed(scope: str, request: Request, email: str) -> None:
    """Raise 429 when this (ip, e-mail), or this public ip, failed too often."""
    now = time.monotonic()
    key = _key(scope, request, email)
    if _recent(_failures, key, now) >= MAX_FAILURES:
        raise _too_many(_failures[key][0], now)
    ip = key[1]
    if not _ip_may_be_shared(ip) and _recent(_ip_failures, ip, now) >= MAX_FAILURES_PER_IP:
        raise _too_many(_ip_failures[ip][0], now)


def record_login_failure(scope: str, request: Request, email: str) -> None:
    """Count one failed attempt for this (ip, e-mail) and, if public, this ip."""
    now = time.monotonic()
    key = _key(scope, request, email)
    _record(_failures, key, now)
    if not _ip_may_be_shared(key[1]):
        _record(_ip_failures, key[1], now)


def record_login_success(scope: str, request: Request, email: str) -> None:
    """Forget the failures of this (ip, e-mail) after a successful login.

    The per-ip bucket is left alone on purpose (see the module docstring).
    """
    _failures.pop(_key(scope, request, email), None)


def reset_login_throttle() -> None:
    """Clear all counters (tests)."""
    _failures.clear()
    _ip_failures.clear()
