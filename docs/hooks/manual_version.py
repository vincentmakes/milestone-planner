"""
MkDocs hook: the version of the manual, read from the repository's /VERSION.

``/VERSION`` is the one source of the version (CLAUDE.md, Versioning); the
manual reads it at build time into ``config.extra.version``, so the print
page's cover (``docs/print-templates/cover_page.tpl``) names the release the
manual was built from -- never a number written into the docs.
"""

from pathlib import Path
from typing import Any


def on_config(config: Any) -> Any:
    version_file = Path(config.config_file_path).parent / "VERSION"
    config.extra["version"] = version_file.read_text(encoding="utf-8").strip()
    return config
