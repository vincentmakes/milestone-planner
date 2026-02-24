"""
Proxy configuration service.
Supports PAC (Proxy Auto-Config) files and direct proxy URLs.
"""

import re

import httpx

from app.config import get_settings

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

    # Debug: print all proxy-related settings
    print(f"[Proxy] Debug - https_proxy: '{settings.https_proxy}'")
    print(f"[Proxy] Debug - http_proxy: '{settings.http_proxy}'")
    print(f"[Proxy] Debug - proxy_pac_url: '{settings.proxy_pac_url}'")

    # Check direct proxy settings first
    if settings.https_proxy:
        print(f"[Proxy] Using HTTPS_PROXY: {settings.https_proxy}")
        return settings.https_proxy
    if settings.http_proxy:
        print(f"[Proxy] Using HTTP_PROXY: {settings.http_proxy}")
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
                        print(f"[Proxy] PAC file resolved to: {proxy}")
                        return proxy
                    else:
                        _cached_proxy = "DIRECT"
                        print("[Proxy] PAC file indicates DIRECT connection")
                        return None
                else:
                    print(f"[Proxy] Failed to fetch PAC file: HTTP {response.status_code}")
        except Exception as e:
            print(f"[Proxy] Error fetching PAC file: {e}")

    print("[Proxy] No proxy configured")
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
