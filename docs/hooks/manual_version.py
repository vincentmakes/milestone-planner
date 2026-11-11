"""
MkDocs hook: what the print page's cover reads from the build.

- ``config.extra.version``: the repository's /VERSION, the one source of the
  version (CLAUDE.md, Versioning), so the cover
  (``docs/print-templates/cover_page.tpl``) names the release the manual was
  built from -- never a number written into the docs;
- ``config.extra.build_month``: the month of the build ("November 2026"),
  from ``SOURCE_DATE_EPOCH`` when set (reproducible builds), else today;
- ``config.extra.cover_description``: one sentence for the cover, from the
  site description.
"""

import os
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

MONTHS = (
    "January February March April May June July August September October November December"
).split()


def build_month(now: datetime | None = None) -> str:
    """The build's month and year, in English whatever the machine's locale."""
    if now is None:
        epoch = os.environ.get("SOURCE_DATE_EPOCH")
        now = datetime.fromtimestamp(int(epoch), UTC) if epoch else datetime.now(UTC)
    return f"{MONTHS[now.month - 1]} {now.year}"


def cover_description(description: str, product: str = "Milestone Planner") -> str:
    """
    The cover's sentence from the site description: what the product is for
    (the part after its dash), as "Using and running <product>: …".
    """
    text = description.split("—", 1)[1].strip() if "—" in description else description.strip()
    text = text.rstrip(".")
    return f"Using and running {product}: {text}." if text else ""


def on_config(config: Any) -> Any:
    version_file = Path(config.config_file_path).parent / "VERSION"
    config.extra["version"] = version_file.read_text(encoding="utf-8").strip()
    config.extra["build_month"] = build_month()
    config.extra["cover_description"] = cover_description(config.site_description or "")
    return config
