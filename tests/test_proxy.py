"""
Outbound proxy resolution (app/services/proxy.py).

Explicit HTTPS_PROXY / HTTP_PROXY always win over a PAC file; a PAC file is
fetched once (without a proxy) and its first ``PROXY`` directive, or DIRECT,
is cached until ``clear_proxy_cache()``. A PAC fetch that fails never raises:
the caller connects directly.
"""

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.services import proxy

PAC_URL = "http://wpad.corp.example/proxy.pac"
TARGET = "https://graph.microsoft.com/v1.0/me"


def settings(https=None, http=None, pac=None):
    # A plain namespace, not Settings(): the sandbox exports HTTPS_PROXY, which
    # pydantic-settings would otherwise read into every unset field.
    return SimpleNamespace(https_proxy=https, http_proxy=http, proxy_pac_url=pac)


@pytest.fixture(autouse=True)
def fresh_cache():
    proxy.clear_proxy_cache()
    yield
    proxy.clear_proxy_cache()


def fake_http_client(*, status_code=200, text="", error=None):
    """Patchable stand-in for ``httpx.AsyncClient`` used as an async context manager."""
    client = MagicMock()
    if error is not None:
        client.get = AsyncMock(side_effect=error)
    else:
        client.get = AsyncMock(return_value=SimpleNamespace(status_code=status_code, text=text))
    ctx = MagicMock()
    ctx.__aenter__ = AsyncMock(return_value=client)
    ctx.__aexit__ = AsyncMock(return_value=False)
    factory = MagicMock(return_value=ctx)
    return factory, client


# ---------------------------------------------------------------------------
# PAC parsing
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("pac", "expected"),
    [
        (
            'function FindProxyForURL(u, h) { return "PROXY proxy.corp:8080"; }',
            "http://proxy.corp:8080",
        ),
        ('return "PROXY proxy.corp:8080; DIRECT";', "http://proxy.corp:8080"),
        ("return 'proxy  edge.corp:3128';", "http://edge.corp:3128"),  # case-insensitive
        ('return "PROXY http://already.prefixed:80";', "http://already.prefixed:80"),
        ('return "PROXY https://tls.proxy:443";', "https://tls.proxy:443"),
        (
            'if (x) return "PROXY first.corp:1"; else return "PROXY second.corp:2";',
            "http://first.corp:1",
        ),
        ('function FindProxyForURL(u, h) { return "DIRECT"; }', None),
        ("", None),
    ],
)
def test_parse_pac_matrix(pac, expected):
    assert proxy._parse_pac_for_url(pac, TARGET) == expected


# ---------------------------------------------------------------------------
# get_proxy_for_url — precedence
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_https_proxy_wins_over_http_proxy_and_pac():
    factory, _ = fake_http_client(text='return "PROXY pac.corp:1";')
    cfg = settings(https="http://s.corp:443", http="http://p.corp:80", pac=PAC_URL)
    with (
        patch.object(proxy, "get_settings", return_value=cfg),
        patch.object(proxy.httpx, "AsyncClient", factory),
    ):
        assert await proxy.get_proxy_for_url(TARGET) == "http://s.corp:443"
    factory.assert_not_called()  # the PAC file is never fetched


@pytest.mark.asyncio
async def test_http_proxy_used_when_no_https_proxy():
    factory, _ = fake_http_client()
    cfg = settings(http="http://p.corp:80", pac=PAC_URL)
    with (
        patch.object(proxy, "get_settings", return_value=cfg),
        patch.object(proxy.httpx, "AsyncClient", factory),
    ):
        assert await proxy.get_proxy_for_url(TARGET) == "http://p.corp:80"
    factory.assert_not_called()


@pytest.mark.asyncio
async def test_nothing_configured_means_direct():
    factory, _ = fake_http_client()
    with (
        patch.object(proxy, "get_settings", return_value=settings()),
        patch.object(proxy.httpx, "AsyncClient", factory),
    ):
        assert await proxy.get_proxy_for_url(TARGET) is None
    factory.assert_not_called()


# ---------------------------------------------------------------------------
# get_proxy_for_url — PAC fetch and cache
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_pac_proxy_is_fetched_once_then_served_from_cache():
    factory, client = fake_http_client(text='return "PROXY pac.corp:8080; DIRECT";')
    with (
        patch.object(proxy, "get_settings", return_value=settings(pac=PAC_URL)),
        patch.object(proxy.httpx, "AsyncClient", factory),
    ):
        assert await proxy.get_proxy_for_url(TARGET) == "http://pac.corp:8080"
        assert await proxy.get_proxy_for_url("https://other.example") == "http://pac.corp:8080"

    client.get.assert_awaited_once_with(PAC_URL)
    factory.assert_called_once_with(timeout=10.0)
    assert proxy._pac_content == 'return "PROXY pac.corp:8080; DIRECT";'
    assert proxy._cached_proxy == "http://pac.corp:8080"


@pytest.mark.asyncio
async def test_direct_pac_is_cached_as_direct():
    factory, client = fake_http_client(text='return "DIRECT";')
    with (
        patch.object(proxy, "get_settings", return_value=settings(pac=PAC_URL)),
        patch.object(proxy.httpx, "AsyncClient", factory),
    ):
        assert await proxy.get_proxy_for_url(TARGET) is None
        assert await proxy.get_proxy_for_url(TARGET) is None

    assert proxy._cached_proxy == "DIRECT"
    client.get.assert_awaited_once()


@pytest.mark.asyncio
async def test_pac_http_error_returns_none_and_caches_nothing():
    factory, client = fake_http_client(status_code=404, text="not found")
    with (
        patch.object(proxy, "get_settings", return_value=settings(pac=PAC_URL)),
        patch.object(proxy.httpx, "AsyncClient", factory),
    ):
        assert await proxy.get_proxy_for_url(TARGET) is None
        assert await proxy.get_proxy_for_url(TARGET) is None

    # Not cached: a transient failure is retried on the next call.
    assert client.get.await_count == 2
    assert proxy._cached_proxy is None


@pytest.mark.asyncio
async def test_pac_fetch_exception_returns_none():
    factory, _ = fake_http_client(error=RuntimeError("connection refused"))
    with (
        patch.object(proxy, "get_settings", return_value=settings(pac=PAC_URL)),
        patch.object(proxy.httpx, "AsyncClient", factory),
    ):
        assert await proxy.get_proxy_for_url(TARGET) is None
    assert proxy._cached_proxy is None


@pytest.mark.asyncio
async def test_clear_proxy_cache_forces_a_refetch():
    factory, client = fake_http_client(text='return "PROXY pac.corp:8080";')
    with (
        patch.object(proxy, "get_settings", return_value=settings(pac=PAC_URL)),
        patch.object(proxy.httpx, "AsyncClient", factory),
    ):
        await proxy.get_proxy_for_url(TARGET)
        proxy.clear_proxy_cache()
        assert proxy._pac_content is None and proxy._cached_proxy is None
        await proxy.get_proxy_for_url(TARGET)

    assert client.get.await_count == 2


# ---------------------------------------------------------------------------
# get_proxy_for_url_sync
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("cfg", "cached", "expected"),
    [
        (settings(https="http://s:1", http="http://p:2"), "http://pac:3", "http://s:1"),
        (settings(http="http://p:2"), "http://pac:3", "http://p:2"),
        (settings(pac=PAC_URL), "http://pac:3", "http://pac:3"),
        (settings(pac=PAC_URL), "DIRECT", None),
        (settings(pac=PAC_URL), None, None),  # PAC not fetched yet: no blocking fetch
        (settings(), None, None),
    ],
)
def test_sync_variant_reads_settings_then_cache(cfg, cached, expected):
    proxy._cached_proxy = cached
    with patch.object(proxy, "get_settings", return_value=cfg):
        assert proxy.get_proxy_for_url_sync(TARGET) == expected
