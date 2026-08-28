"""
Proxy configuration service.
Supports PAC (Proxy Auto-Config) files and direct proxy URLs.
"""

import logging
import re
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from urllib.parse import urlparse, urlunparse

import httpx

from app.config import get_settings

logger = logging.getLogger(__name__)

# Cache for PAC file content and parsed proxy
_pac_content: str | None = None
_cached_proxy: str | None = None


def _parse_pac_for_url(pac_content: str, url: str) -> str | None:
    """
    Simple PAC file parser.

    PAC files are JavaScript, but we can extract common patterns:
    - DIRECT = no proxy
    - PROXY host:port = use this proxy

    This is a simplified parser that looks for PROXY directives.
    For complex PAC files, you may need to extract the proxy manually.
    """
    # Try to find PROXY directive in the PAC file
    # Common patterns:
    # return "PROXY proxy.example.com:8080";
    # return "PROXY proxy.example.com:8080; DIRECT";

    proxy_pattern = r'PROXY\s+([^;\s"\']+)'
    matches = re.findall(proxy_pattern, pac_content, re.IGNORECASE)

    if matches:
        # Return the first proxy found
        proxy_host = matches[0]
        # Ensure it has http:// prefix
        if not proxy_host.startswith("http"):
            proxy_host = f"http://{proxy_host}"
        return proxy_host

    return None


async def get_proxy_for_url(url: str) -> str | None:
    """
    Get the proxy URL to use for a given target URL.

    Checks in order:
    1. Direct proxy settings (HTTPS_PROXY, HTTP_PROXY)
    2. PAC file (PROXY_PAC_URL)

    Returns None if no proxy should be used (DIRECT).
    """
    global _pac_content, _cached_proxy

    settings = get_settings()

    # Debug: log all proxy-related settings
    logger.debug("https_proxy: '%s'", settings.https_proxy)
    logger.debug("http_proxy: '%s'", settings.http_proxy)
    logger.debug("proxy_pac_url: '%s'", settings.proxy_pac_url)

    # Check direct proxy settings first
    if settings.https_proxy:
        logger.info("Using HTTPS_PROXY: %s", settings.https_proxy)
        return settings.https_proxy
    if settings.http_proxy:
        logger.info("Using HTTP_PROXY: %s", settings.http_proxy)
        return settings.http_proxy

    # Check PAC file
    if settings.proxy_pac_url:
        # Use cached proxy if available
        if _cached_proxy is not None:
            return _cached_proxy if _cached_proxy != "DIRECT" else None

        try:
            # Fetch PAC file (without proxy!)
            async with httpx.AsyncClient(timeout=10.0) as client:
                response = await client.get(settings.proxy_pac_url)
                if response.status_code == 200:
                    _pac_content = response.text

                    # Parse PAC file for the target URL
                    proxy = _parse_pac_for_url(_pac_content, url)

                    if proxy:
                        _cached_proxy = proxy
                        logger.info("PAC file resolved to: %s", proxy)
                        return proxy
                    else:
                        _cached_proxy = "DIRECT"
                        logger.info("PAC file indicates DIRECT connection")
                        return None
                else:
                    logger.warning("Failed to fetch PAC file: HTTP %s", response.status_code)
        except Exception as e:
            logger.error("Error fetching PAC file: %s", e)

    logger.debug("No proxy configured")
    return None


def get_proxy_for_url_sync(url: str) -> str | None:
    """
    Synchronous version - uses cached value or returns configured proxy.
    For use in contexts where async isn't available.
    """
    global _cached_proxy

    settings = get_settings()

    # Check direct proxy settings first
    if settings.https_proxy:
        return settings.https_proxy
    if settings.http_proxy:
        return settings.http_proxy

    # Return cached PAC result
    if _cached_proxy is not None:
        return _cached_proxy if _cached_proxy != "DIRECT" else None

    return None


def clear_proxy_cache():
    """Clear the cached proxy settings (useful for testing or config changes)."""
    global _pac_content, _cached_proxy
    _pac_content = None
    _cached_proxy = None


def resolve_ssl_verify() -> bool | str:
    """SSL verification setting - a custom CA cert wins over the boolean flag."""
    settings = get_settings()

    if settings.proxy_ca_cert:
        logger.info("Using custom CA certificate: %s", settings.proxy_ca_cert)
        return settings.proxy_ca_cert
    if not settings.proxy_verify_ssl:
        logger.info("SSL verification disabled for proxy")
    return settings.proxy_verify_ssl


async def resolve_proxy(url: str) -> str | None:
    """Resolve the outbound proxy for a URL, injecting credentials if configured."""
    settings = get_settings()
    proxy_url = await get_proxy_for_url(url)

    if not proxy_url:
        return None

    logger.info("Using proxy: %s", proxy_url)

    if settings.proxy_username and settings.proxy_password:
        parsed = urlparse(proxy_url)
        proxy_url = urlunparse(
            (
                parsed.scheme,
                f"{settings.proxy_username}:{settings.proxy_password}@{parsed.netloc}",
                parsed.path,
                parsed.params,
                parsed.query,
                parsed.fragment,
            )
        )
        logger.info("Proxy authentication enabled for user: %s", settings.proxy_username)

    return proxy_url


@asynccontextmanager
async def async_client(url: str, *, timeout: float = 10.0) -> AsyncIterator[httpx.AsyncClient]:
    """
    An ``httpx`` client configured for this deployment's outbound network.

    Everything the app calls out to — the holiday API, Entra, Microsoft Graph —
    goes through whatever proxy and CA bundle the deployment configured
    (``HTTP(S)_PROXY``, ``PROXY_PAC_URL``, ``PROXY_USERNAME``/``PROXY_PASSWORD``,
    ``PROXY_CA_CERT``, ``PROXY_VERIFY_SSL``). Reach for this rather than
    constructing a bare client, so a corporate network only has to be described
    once and no call is left with an unbounded timeout.
    """
    async with httpx.AsyncClient(
        timeout=timeout,
        proxy=await resolve_proxy(url),
        verify=resolve_ssl_verify(),
    ) as client:
        yield client
