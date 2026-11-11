"""
Shared plumbing of the load test: HTTP clients, sign-in, per-endpoint timing
and the report.

Only ``httpx`` (already in requirements.txt). Every client is created with
``trust_env=False``: a load test talks to a local or CI server, never through
an outbound proxy configured in the environment.
"""

from __future__ import annotations

import os
import re
import statistics
import time
from dataclasses import dataclass, field
from typing import Any

import httpx

DEFAULT_BASE_URL = os.environ.get("LOADTEST_BASE_URL", "http://127.0.0.1:8485")
ADMIN_EMAIL = os.environ.get("LOADTEST_ADMIN_EMAIL", "admin@milestone.local")
ADMIN_PASSWORD = os.environ.get("LOADTEST_ADMIN_PASSWORD", "")
# The password of every user the seeder creates (lt-user-NNN@loadtest.local).
USER_PASSWORD = os.environ.get("LOADTEST_USER_PASSWORD", "loadtest-1234")
USER_EMAIL_DOMAIN = "loadtest.local"
NAME_PREFIX = "LT"


def user_email(index: int) -> str:
    """The seeded user number ``index`` (1-based)."""
    return f"lt-user-{index:03d}@{USER_EMAIL_DOMAIN}"


def make_client(base_url: str, connections: int | None = None, timeout: float = 120.0) -> Any:
    """A client with at most ``connections`` parallel connections (None or 0:
    unlimited, as a browser behind an HTTP/2 proxy)."""
    limit = connections or None
    return httpx.AsyncClient(
        base_url=base_url,
        trust_env=False,
        timeout=timeout,
        # Idle connections are dropped after 2 s, before uvicorn's 5 s
        # keep-alive timeout closes them server-side: a browser silently
        # retries a request that lands on such a closed connection, httpx
        # reports it (RemoteProtocolError), which is not the server's fault.
        limits=httpx.Limits(
            max_connections=limit, max_keepalive_connections=limit, keepalive_expiry=2.0
        ),
    )


_ID = re.compile(r"/\d+(?=/|$)")


def endpoint_key(method: str, url: str) -> str:
    """``GET /api/projects/{id}``: ids folded, query keys kept (values dropped)."""
    path, _, query = url.partition("?")
    path = _ID.sub("/{id}", path)
    keys = sorted({part.split("=", 1)[0] for part in query.split("&") if part})
    return f"{method} {path}" + (f"?{'&'.join(keys)}" if keys else "")


@dataclass
class Sample:
    status: int | str
    seconds: float


@dataclass
class Recorder:
    """Every request's status and duration, by endpoint."""

    samples: dict[str, list[Sample]] = field(default_factory=dict)
    errors: list[str] = field(default_factory=list)

    async def request(
        self, client: Any, method: str, url: str, *, label: str | None = None, **kwargs: Any
    ) -> Any:
        """Send one request and record it; returns the response or None."""
        key = label or endpoint_key(method, url)
        started = time.perf_counter()
        try:
            response = await client.request(method, url, **kwargs)
        except httpx.HTTPError as exc:
            self._add(key, type(exc).__name__, time.perf_counter() - started)
            self.errors.append(f"{key}: {type(exc).__name__} {exc}")
            return None
        self._add(key, response.status_code, time.perf_counter() - started)
        if not 200 <= response.status_code < 300:
            self.errors.append(f"{key}: {response.status_code} {response.text[:160]}")
        return response

    def _add(self, key: str, status: int | str, seconds: float) -> None:
        self.samples.setdefault(key, []).append(Sample(status, seconds))

    def all_samples(self) -> list[Sample]:
        return [s for samples in self.samples.values() for s in samples]

    def failures(self) -> int:
        return sum(1 for s in self.all_samples() if not _ok(s.status))


def _ok(status: int | str) -> bool:
    return isinstance(status, int) and 200 <= status < 300


def percentile(values: list[float], fraction: float) -> float:
    ordered = sorted(values)
    if not ordered:
        return 0.0
    return ordered[min(len(ordered) - 1, int(len(ordered) * fraction))]


def report(recorder: Recorder, title: str) -> None:
    """One line per endpoint: requests, non-2xx, median, p95, max."""
    print(f"\n== {title}")
    width = max([len(k) for k in recorder.samples] + [8])
    print(f"{'endpoint':<{width}}  {'reqs':>5} {'non2xx':>6} {'median':>7} {'p95':>7} {'max':>7}")
    for key in sorted(recorder.samples):
        samples = recorder.samples[key]
        times = [s.seconds for s in samples]
        bad = sum(1 for s in samples if not _ok(s.status))
        print(
            f"{key:<{width}}  {len(samples):>5} {bad:>6} {statistics.median(times):>6.2f}s "
            f"{percentile(times, 0.95):>6.2f}s {max(times):>6.2f}s"
        )
    everything = [s.seconds for s in recorder.all_samples()]
    if everything:
        statuses: dict[str, int] = {}
        for sample in recorder.all_samples():
            statuses[str(sample.status)] = statuses.get(str(sample.status), 0) + 1
        print(
            f"{'ALL':<{width}}  {len(everything):>5} {recorder.failures():>6} "
            f"{statistics.median(everything):>6.2f}s {percentile(everything, 0.95):>6.2f}s "
            f"{max(everything):>6.2f}s   status counts {statuses}"
        )
    for line in recorder.errors[:15]:
        print(f"  ! {line}")
    if len(recorder.errors) > 15:
        print(f"  ! ... {len(recorder.errors) - 15} more")


def verdict(
    recorder: Recorder, *, max_seconds: float | None = None, max_p95: float | None = None
) -> list[str]:
    """Why the run fails (empty: it passes): any non-2xx, or a ceiling exceeded."""
    problems = []
    if recorder.failures():
        problems.append(f"{recorder.failures()} request(s) did not answer 2xx")
    times = [s.seconds for s in recorder.all_samples()]
    if times and max_seconds is not None and max(times) > max_seconds:
        slow = [
            f"{key} {max(s.seconds for s in samples):.1f}s"
            for key, samples in recorder.samples.items()
            if max(s.seconds for s in samples) > max_seconds
        ]
        problems.append(f"slowest request {max(times):.1f}s > {max_seconds}s: {', '.join(slow)}")
    if times and max_p95 is not None and percentile(times, 0.95) > max_p95:
        problems.append(f"p95 {percentile(times, 0.95):.1f}s > {max_p95}s")
    return problems


async def login(client: Any, email: str, password: str, recorder: Recorder | None = None) -> dict:
    """Sign in (raises on failure) and return ``/api/auth/me``'s user."""
    body = {"email": email, "password": password}
    if recorder is not None:
        response = await recorder.request(client, "POST", "/api/auth/login", json=body)
    else:
        response = await client.post("/api/auth/login", json=body)
    if response is None or response.status_code != 200:
        detail = "no response" if response is None else f"{response.status_code} {response.text}"
        raise SystemExit(f"Sign-in failed for {email}: {detail}")
    me = await client.get("/api/auth/me")
    me.raise_for_status()
    user = me.json().get("user")
    if not user:
        raise SystemExit(f"Signed in as {email} but /api/auth/me has no user")
    return user


def require_ok(response: Any, what: str) -> Any:
    """The JSON body of a 2xx response, else exit with the error (seeding)."""
    if response.status_code >= 300:
        raise SystemExit(f"{what} failed: {response.status_code} {response.text[:300]}")
    return response.json() if response.content else None
