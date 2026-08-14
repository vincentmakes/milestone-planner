"""Tests for the Nager holiday API client (app/services/holidays.py)."""

from datetime import date, datetime

import httpx
import pytest

from app.services.holidays import (
    MAX_NAME_LENGTH,
    NagerHoliday,
    build_holidays_url,
    fetch_holidays,
    is_relevant_holiday,
    nager_api_version,
    parse_holidays,
)

V4_ITEMS = [
    {
        "date": "2026-01-01",
        "name": "New Year's Day",
        "countryCode": "CH",
        "nationalHoliday": True,
        "subdivisionCodes": [],
        "holidayTypes": ["Public"],
    },
    {
        "date": "2026-01-02",
        "name": "Berchtold's Day",
        "countryCode": "CH",
        "nationalHoliday": False,
        "subdivisionCodes": ["CH-ZH", "CH-BE"],
        "holidayTypes": ["Public"],
    },
    {
        "date": "2026-03-19",
        "name": "St. Joseph's Day",
        "countryCode": "CH",
        "nationalHoliday": False,
        "subdivisionCodes": ["CH-TI"],
        "holidayTypes": ["Public"],
    },
    {
        "date": "2026-05-01",
        "name": "Labour Day",
        "countryCode": "CH",
        "nationalHoliday": False,
        "subdivisionCodes": ["CH-ZH"],
        "holidayTypes": ["Optional", "Observance"],
    },
]

V3_ITEMS = [
    {
        "date": "2026-01-01",
        "localName": "Neujahr",
        "name": "New Year's Day",
        "countryCode": "CH",
        "fixed": True,
        "global": True,
        "counties": None,
        "launchYear": None,
        "types": ["Public"],
    },
    {
        "date": "2026-01-02",
        "localName": "Berchtoldstag",
        "name": "Berchtold's Day",
        "countryCode": "CH",
        "fixed": True,
        "global": False,
        "counties": ["CH-ZH", "CH-BE"],
        "types": ["Public"],
    },
]


def make_holiday(**overrides) -> NagerHoliday:
    defaults = {
        "date": date(2026, 1, 1),
        "name": "New Year's Day",
        "national": True,
        "subdivision_codes": [],
        "types": ["Public"],
    }
    defaults.update(overrides)
    return NagerHoliday(**defaults)


# ---------------------------------------------------------
# Version detection & URL building
# ---------------------------------------------------------


@pytest.mark.parametrize(
    "base_url,expected",
    [
        ("https://nagerholidays.com/api/v4", 4),
        ("https://nagerholidays.com/api/v4/", 4),
        ("https://date.nager.at/api/v3", 3),
        ("https://date.nager.at/api/V3", 3),
        ("https://example.com/holidays", 4),  # unrecognised -> current version
    ],
)
def test_nager_api_version(base_url, expected):
    assert nager_api_version(base_url) == expected


def test_build_holidays_url_v4_puts_country_before_year():
    url = build_holidays_url("https://nagerholidays.com/api/v4", "CH", 2026, 4)
    assert url == "https://nagerholidays.com/api/v4/Holidays/CH/2026"


def test_build_holidays_url_v3_puts_year_before_country():
    url = build_holidays_url("https://date.nager.at/api/v3", "CH", 2026, 3)
    assert url == "https://date.nager.at/api/v3/PublicHolidays/2026/CH"


def test_build_holidays_url_strips_trailing_slash():
    url = build_holidays_url("https://nagerholidays.com/api/v4/", "DE", 2027, 4)
    assert url == "https://nagerholidays.com/api/v4/Holidays/DE/2027"


# ---------------------------------------------------------
# Field mapping
# ---------------------------------------------------------


def test_parse_holidays_v4_maps_fields():
    holidays = parse_holidays(V4_ITEMS, 4)

    assert len(holidays) == 4
    first = holidays[0]
    assert first.date == date(2026, 1, 1)
    assert first.name == "New Year's Day"
    assert first.national is True
    assert first.subdivision_codes == []
    assert first.types == ["Public"]

    second = holidays[1]
    assert second.national is False
    assert second.subdivision_codes == ["CH-ZH", "CH-BE"]


def test_parse_holidays_v3_prefers_local_name():
    holidays = parse_holidays(V3_ITEMS, 3)

    assert [h.name for h in holidays] == ["Neujahr", "Berchtoldstag"]
    assert holidays[0].national is True
    assert holidays[0].subdivision_codes == []
    assert holidays[1].subdivision_codes == ["CH-ZH", "CH-BE"]


def test_parse_holidays_v4_has_no_local_name_fallback():
    """v4 dropped localName - a stray one must not be preferred over name."""
    holidays = parse_holidays(
        [{"date": "2026-01-01", "name": "New Year's Day", "localName": "Neujahr"}], 4
    )
    assert holidays[0].name == "New Year's Day"


@pytest.mark.parametrize(
    "value",
    [
        "2026-01-01",
        "2026-01-01T00:00:00",
        "2026-01-01T00:00:00Z",
        "2026-01-01T00:00:00.0000000",
    ],
)
def test_parse_holidays_accepts_date_and_datetime_strings(value):
    holidays = parse_holidays([{"date": value, "name": "New Year's Day"}], 4)
    assert holidays[0].date == date(2026, 1, 1)


def test_parse_holidays_accepts_date_objects():
    holidays = parse_holidays([{"date": datetime(2026, 1, 1, 12, 0), "name": "X"}], 4)
    assert holidays[0].date == date(2026, 1, 1)


@pytest.mark.parametrize(
    "entry",
    [
        {"name": "No date"},
        {"date": "not-a-date", "name": "Bad date"},
        {"date": "2026-01-01"},  # no name
        {"date": "2026-01-01", "name": "   "},
    ],
)
def test_parse_holidays_skips_malformed_entries(entry):
    payload = [entry, {"date": "2026-12-25", "name": "Christmas Day"}]
    holidays = parse_holidays(payload, 4)

    assert len(holidays) == 1
    assert holidays[0].name == "Christmas Day"


def test_parse_holidays_truncates_long_names():
    holidays = parse_holidays([{"date": "2026-01-01", "name": "x" * 300}], 4)
    assert len(holidays[0].name) == MAX_NAME_LENGTH


def test_parse_holidays_coerces_string_type_field():
    holidays = parse_holidays([{"date": "2026-01-01", "name": "X", "holidayTypes": "Public"}], 4)
    assert holidays[0].types == ["Public"]


# ---------------------------------------------------------
# Type filtering
# ---------------------------------------------------------


@pytest.mark.parametrize(
    "types,expected",
    [
        (["Public"], True),
        (["Bank"], True),
        (["public"], True),
        (["Public", "School"], True),
        (["School"], False),
        (["Optional", "Observance"], False),
        (["Authorities"], False),
        ([], True),  # no type information -> keep
    ],
)
def test_is_relevant_holiday_filters_types(types, expected):
    assert is_relevant_holiday(make_holiday(types=types), None) is expected


# ---------------------------------------------------------
# Region filtering
# ---------------------------------------------------------


def _names_for_region(region_code, items=V4_ITEMS, version=4):
    holidays = parse_holidays(items, version)
    return [h.name for h in holidays if is_relevant_holiday(h, region_code)]


@pytest.mark.parametrize("region_code", ["BE", "CH-BE", "be"])
def test_region_filter_matches_bare_and_full_codes(region_code):
    # Labour Day is dropped by the type filter, St. Joseph's Day by the region.
    assert _names_for_region(region_code) == ["New Year's Day", "Berchtold's Day"]


def test_region_filter_without_region_keeps_all_relevant_types():
    assert _names_for_region(None) == [
        "New Year's Day",
        "Berchtold's Day",
        "St. Joseph's Day",
    ]


def test_region_filter_keeps_national_holidays():
    holiday = make_holiday(national=True, subdivision_codes=["CH-TI"])
    assert is_relevant_holiday(holiday, "ZH") is True


def test_region_filter_keeps_entries_without_subdivisions():
    holiday = make_holiday(national=False, subdivision_codes=[])
    assert is_relevant_holiday(holiday, "ZH") is True


def test_region_filter_drops_other_subdivisions():
    holiday = make_holiday(national=False, subdivision_codes=["CH-TI"])
    assert is_relevant_holiday(holiday, "ZH") is False


def test_region_filter_behaves_the_same_on_v3():
    assert _names_for_region("BE", items=V3_ITEMS, version=3) == ["Neujahr", "Berchtoldstag"]


# ---------------------------------------------------------
# fetch_holidays (over httpx.MockTransport)
# ---------------------------------------------------------


def mock_client(handler) -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


async def test_fetch_holidays_requests_the_v4_url(monkeypatch):
    monkeypatch.setattr(
        "app.services.holidays.get_settings",
        lambda: type("S", (), {"nager_api_url": "https://nagerholidays.com/api/v4"})(),
    )
    requested = []

    def handler(request: httpx.Request) -> httpx.Response:
        requested.append(str(request.url))
        return httpx.Response(200, json=V4_ITEMS)

    async with mock_client(handler) as client:
        holidays = await fetch_holidays("CH", 2026, client=client)

    assert requested == ["https://nagerholidays.com/api/v4/Holidays/CH/2026"]
    assert [h.name for h in holidays] == [
        "New Year's Day",
        "Berchtold's Day",
        "St. Joseph's Day",
        "Labour Day",
    ]


async def test_fetch_holidays_requests_the_v3_url_and_parses_v3_fields(monkeypatch):
    monkeypatch.setattr(
        "app.services.holidays.get_settings",
        lambda: type("S", (), {"nager_api_url": "https://date.nager.at/api/v3"})(),
    )
    requested = []

    def handler(request: httpx.Request) -> httpx.Response:
        requested.append(str(request.url))
        return httpx.Response(200, json=V3_ITEMS)

    async with mock_client(handler) as client:
        holidays = await fetch_holidays("CH", 2026, client=client)

    assert requested == ["https://date.nager.at/api/v3/PublicHolidays/2026/CH"]
    assert [h.name for h in holidays] == ["Neujahr", "Berchtoldstag"]


@pytest.mark.parametrize(
    "response",
    [
        httpx.Response(404),
        httpx.Response(500),
        httpx.Response(200, text="<html>proxy error</html>"),
        httpx.Response(200, json={"error": "nope"}),
    ],
)
async def test_fetch_holidays_fails_soft(monkeypatch, response):
    monkeypatch.setattr(
        "app.services.holidays.get_settings",
        lambda: type("S", (), {"nager_api_url": "https://nagerholidays.com/api/v4"})(),
    )

    async with mock_client(lambda request: response) as client:
        assert await fetch_holidays("CH", 2026, client=client) == []


async def test_fetch_holidays_returns_empty_on_transport_error(monkeypatch):
    monkeypatch.setattr(
        "app.services.holidays.get_settings",
        lambda: type("S", (), {"nager_api_url": "https://nagerholidays.com/api/v4"})(),
    )

    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("unreachable", request=request)

    async with mock_client(handler) as client:
        assert await fetch_holidays("CH", 2026, client=client) == []
