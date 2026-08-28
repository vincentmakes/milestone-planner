"""
Public-holiday lookup against the Nager holiday API.

Supports both the current API (v4, https://nagerholidays.com/api/v4) and the
legacy v3 API (end of life 2027-01-31), auto-detected from ``NAGER_API_URL``:

    v4  GET {base}/Holidays/{countryCode}/{year}
    v3  GET {base}/PublicHolidays/{year}/{countryCode}

The two versions return different field names, so responses are normalised into
:class:`NagerHoliday` before the caller sees them.
"""

import logging
from dataclasses import dataclass, field
from datetime import date as date_type
from datetime import datetime
from typing import Any
from urllib.parse import urlparse, urlunparse

import httpx

from app.config import get_settings

logger = logging.getLogger(__name__)

# Holiday types that count as a non-working day for planning purposes.
# v4 also returns School / Authorities / Optional / Observance entries, which
# are not days off and must not shrink staff availability.
RELEVANT_HOLIDAY_TYPES = frozenset({"public", "bank"})

# BankHoliday.name is String(200)
MAX_NAME_LENGTH = 200


@dataclass
class NagerHoliday:
    """A single holiday, normalised across API versions."""

    date: date_type
    name: str
    national: bool = True
    subdivision_codes: list[str] = field(default_factory=list)
    types: list[str] = field(default_factory=list)


def nager_api_version(base_url: str) -> int:
    """
    Detect the API version from the configured base URL.

    Falls back to the current version (4) for anything unrecognised.
    """
    last_segment = base_url.rstrip("/").rsplit("/", 1)[-1].lower()

    if last_segment == "v3":
        return 3
    if last_segment != "v4":
        logger.warning("Could not detect the Nager API version from '%s' - assuming v4", base_url)
    return 4


def build_holidays_url(base_url: str, country_code: str, year: int, version: int) -> str:
    """Build the holiday request URL for the given API version."""
    base = base_url.rstrip("/")

    if version == 3:
        return f"{base}/PublicHolidays/{year}/{country_code}"
    return f"{base}/Holidays/{country_code}/{year}"


def _as_str_list(value: Any) -> list[str]:
    """Coerce an API field to a list of strings (a bare string becomes one item)."""
    if value is None:
        return []
    if isinstance(value, str):
        return [value] if value.strip() else []
    if isinstance(value, list | tuple | set):
        return [str(item).strip() for item in value if str(item).strip()]
    return []


def _parse_date(value: Any) -> date_type:
    """
    Parse the API's date field.

    v3 returns "2026-01-01"; v4 serialises a DateTime, which may carry a time
    component ("2026-01-01T00:00:00"), so only the date part is used.
    """
    # datetime subclasses date, so it has to be narrowed first
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date_type):
        return value
    return date_type.fromisoformat(str(value)[:10])


def _parse_holiday(entry: dict[str, Any], version: int) -> NagerHoliday:
    """Normalise a single API entry. Raises on malformed input."""
    if version == 3:
        # v3: localName is the local-language name, name the English one.
        name = entry.get("localName") or entry["name"]
        subdivision_codes = _as_str_list(entry.get("counties"))
        national = bool(entry.get("global", True))
        types = _as_str_list(entry.get("types"))
    else:
        # v4 dropped localName; only the English name remains.
        name = entry["name"]
        subdivision_codes = _as_str_list(entry.get("subdivisionCodes"))
        national = bool(entry.get("nationalHoliday", True))
        types = _as_str_list(entry.get("holidayTypes"))

    name = str(name).strip()
    if not name:
        raise ValueError("holiday has no name")

    return NagerHoliday(
        date=_parse_date(entry["date"]),
        # The name column is String(200)
        name=name[:MAX_NAME_LENGTH],
        national=national,
        subdivision_codes=subdivision_codes,
        types=types,
    )


def parse_holidays(payload: list[dict[str, Any]], version: int) -> list[NagerHoliday]:
    """
    Normalise an API response into :class:`NagerHoliday` objects.

    Malformed entries are skipped individually rather than failing the batch.
    """
    holidays: list[NagerHoliday] = []

    for entry in payload:
        try:
            holidays.append(_parse_holiday(entry, version))
        except Exception as e:
            logger.warning("Skipping malformed holiday entry %s: %s", entry, e)

    return holidays


def _subdivision_suffix(code: str) -> str:
    """'CH-ZH' -> 'ZH'; 'ZH' -> 'ZH'. Used to compare region codes."""
    return code.strip().upper().rsplit("-", 1)[-1]


def matches_region(holiday: NagerHoliday, region_code: str | None) -> bool:
    """
    Whether a holiday applies to a site's region.

    Kept: everything when the site has no region code, holidays that apply
    nationally, and holidays with no subdivision list (permissive, matching the
    previous behaviour). Otherwise the subdivision codes must contain the site's
    region. Region codes are stored bare ("ZH") while the API returns ISO-3166-2
    codes ("CH-ZH"), so both sides are compared on their last segment - a site
    configured with either form works.
    """
    if not region_code or not region_code.strip():
        return True
    if holiday.national or not holiday.subdivision_codes:
        return True

    wanted = _subdivision_suffix(region_code)
    return any(_subdivision_suffix(code) == wanted for code in holiday.subdivision_codes)


def is_relevant_holiday(holiday: NagerHoliday, region_code: str | None) -> bool:
    """
    Decide whether a holiday should be stored for a site.

    Two filters:
    - Type: keep public and bank holidays. Entries without any type information
      are kept (be permissive if the API omits the field).
    - Region: see :func:`matches_region`.
    """
    if holiday.types:
        if not any(t.lower() in RELEVANT_HOLIDAY_TYPES for t in holiday.types):
            return False

    return matches_region(holiday, region_code)


def _resolve_ssl_verify() -> bool | str:
    """SSL verification setting - a custom CA cert wins over the boolean flag."""
    settings = get_settings()

    if settings.proxy_ca_cert:
        logger.info("Using custom CA certificate: %s", settings.proxy_ca_cert)
        return settings.proxy_ca_cert
    if not settings.proxy_verify_ssl:
        logger.info("SSL verification disabled for proxy")
    return settings.proxy_verify_ssl


async def _resolve_proxy(url: str) -> str | None:
    """Resolve the outbound proxy for a URL, injecting credentials if configured."""
    from app.services.proxy import get_proxy_for_url

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


async def fetch_holidays(
    country_code: str,
    year: int,
    client: httpx.AsyncClient | None = None,
) -> list[NagerHoliday]:
    """
    Fetch holidays for a country and year from the Nager API.

    Fails soft: any transport error, non-200 response or unparseable body is
    logged and returns an empty list, so site creation/editing never breaks
    because the holiday API is unreachable.

    An ``httpx.AsyncClient`` may be injected (used by the tests); otherwise one
    is created with the configured proxy and SSL settings.
    """
    settings = get_settings()
    version = nager_api_version(settings.nager_api_url)
    url = build_holidays_url(settings.nager_api_url, country_code, year, version)

    if version == 3:
        logger.warning(
            "NAGER_API_URL points at the legacy v3 API (%s), which reaches end of life on "
            "2027-01-31 - update it to https://nagerholidays.com/api/v4",
            settings.nager_api_url,
        )

    if client is not None:
        return await _request_holidays(client, url, country_code, year, version)

    proxy_url = await _resolve_proxy(settings.nager_api_url)
    ssl_verify = _resolve_ssl_verify()

    async with httpx.AsyncClient(timeout=10.0, proxy=proxy_url, verify=ssl_verify) as new_client:
        return await _request_holidays(new_client, url, country_code, year, version)


async def _request_holidays(
    client: httpx.AsyncClient,
    url: str,
    country_code: str,
    year: int,
    version: int,
) -> list[NagerHoliday]:
    """Perform the request and normalise the response. Never raises."""
    logger.info("Fetching: %s", url)

    try:
        response = await client.get(url)
    except httpx.RequestError as e:
        logger.error("Request error fetching holidays for %s/%s: %s", country_code, year, e)
        return []

    if response.status_code != 200:
        logger.warning(
            "Failed to fetch holidays for %s/%s: HTTP %s",
            country_code,
            year,
            response.status_code,
        )
        logger.debug("  Response headers: %s", dict(response.headers))
        logger.debug("  Response body: %s", response.text[:500])
        return []

    try:
        payload = response.json()
    except Exception as e:
        logger.error("Invalid JSON from holiday API for %s/%s: %s", country_code, year, e)
        return []

    if not isinstance(payload, list):
        logger.error(
            "Unexpected holiday API payload for %s/%s: expected a list, got %s",
            country_code,
            year,
            type(payload).__name__,
        )
        return []

    holidays = parse_holidays(payload, version)
    logger.info("Received %d holidays for %s/%s", len(holidays), country_code, year)
    return holidays
