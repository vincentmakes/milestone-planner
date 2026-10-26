"""
Schemas for the Microsoft Entra SSO diagnostic.

Shared by the admin-portal organization test
(``POST /admin/organizations/{id}/sso/test``) and the tenant test
(``POST /api/auth/sso/test``); both run ``app.services.sso_test``.
"""

from typing import Any

from pydantic import BaseModel, ConfigDict, Field, field_validator


class SSOTestCheck(BaseModel):
    """One check performed by the SSO diagnostic."""

    name: str
    status: str
    """``pass`` | ``warn`` | ``fail`` | ``manual``."""
    message: str
    code: str | None = None
    """A Microsoft ``AADSTS…`` code, when Entra supplied one."""


class SSOTestResponse(BaseModel):
    """
    Result of testing an SSO configuration.

    ``credentials_ok`` is deliberately not called ``sso_ok``: the probe signs in
    as the application itself, which never involves a redirect URI, so it cannot
    tell whether the redirect URI is registered under the right platform. That
    check is reported as a ``manual`` row for a human to confirm.
    """

    model_config = ConfigDict(populate_by_name=True)

    credentials_ok: bool = Field(False, alias="credentialsOk")
    summary: str
    checks: list[SSOTestCheck] = []


class SSOTestRequest(BaseModel):
    """
    The tenant SSO values to test, as entered in Settings → SSO (nothing is saved).

    ``tenant_id`` is interpolated into the ``login.microsoftonline.com`` URL
    path, so it is limited to the characters a directory GUID or domain uses —
    a ``/``, ``?`` or ``#`` would point the probe somewhere else.
    A missing, blank or masked (``****abcd``) ``client_secret`` means "test the
    stored secret", the same rule the save routes apply.
    """

    tenant_id: str = Field(max_length=100, pattern=r"^[A-Za-z0-9.-]+$")
    client_id: str = Field(max_length=100)
    client_secret: str | None = Field(None, max_length=200)
    redirect_uri: str = Field(max_length=500)

    @field_validator("tenant_id", "client_id", "redirect_uri", mode="before")
    @classmethod
    def _strip_required(cls, value: Any) -> Any:
        """Trim a pasted newline; a required field stays a ``str``."""
        return value.strip() if isinstance(value, str) else value

    @field_validator("client_secret", mode="before")
    @classmethod
    def _strip_secret(cls, value: Any) -> Any:
        """Trim the secret; a blank one becomes None (= the stored secret)."""
        if isinstance(value, str):
            return value.strip() or None
        return value
