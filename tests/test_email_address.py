"""
EmailAddress (app/schemas/base.py): the e-mail type of every user and
administrator body. It accepts the reserved ``.local`` domain (the demo
accounts, the quick-start admin) that ``pydantic.EmailStr`` refuses, makes no
DNS lookup, normalises the domain, and refuses anything else invalid with one
plain message.
"""

import email_validator
import pytest
from pydantic import BaseModel, TypeAdapter, ValidationError

from app.schemas.base import EMAIL_INVALID_MESSAGE, EmailAddress
from app.schemas.tenant import AdminUserCreate, ResetAdminPasswordRequest, TenantCreate
from app.schemas.user import StaffCreate, StaffUpdate

ADAPTER = TypeAdapter(EmailAddress)


@pytest.mark.parametrize(
    ("value", "normalised"),
    [
        ("diana@demo.local", "diana@demo.local"),
        ("admin@milestone.local", "admin@milestone.local"),
        ("Diana@Demo.LOCAL", "Diana@demo.local"),
        ("a.b+c@example.org", "a.b+c@example.org"),
        ("a.b+c@Example.ORG", "a.b+c@example.org"),
        # No DNS lookup and no "globally deliverable" rule: an intranet name.
        ("ops@intranet", "ops@intranet"),
    ],
)
def test_accepted_and_normalised(value, normalised):
    assert ADAPTER.validate_python(value) == normalised


@pytest.mark.parametrize(
    "value",
    ["not-an-email", "x@", "@y.z", "a b@example.org", "a@@example.org", "a@localhost", ""],
)
def test_refused_with_the_plain_message(value):
    with pytest.raises(ValidationError) as caught:
        ADAPTER.validate_python(value)
    (error,) = caught.value.errors()
    assert error["msg"] == EMAIL_INVALID_MESSAGE == "Enter a valid e-mail address"


def test_only_local_is_allowed_among_the_reserved_names():
    assert "local" not in email_validator.SPECIAL_USE_DOMAIN_NAMES
    for name in ("localhost", "invalid", "test", "onion", "arpa"):
        assert name in email_validator.SPECIAL_USE_DOMAIN_NAMES


def test_every_email_field_uses_the_type():
    class Probe(BaseModel):
        email: EmailAddress

    assert Probe(email="x@demo.local").email == "x@demo.local"
    created = StaffCreate(
        email="x@demo.local", password="long-enough", first_name="X", last_name="Y"
    )
    assert created.email == "x@demo.local"
    assert StaffUpdate(email="x@demo.local").email == "x@demo.local"
    assert ResetAdminPasswordRequest(email="root@acme.local").email == "root@acme.local"
    assert AdminUserCreate(email="root@milestone.local", password="long-enough").email == (
        "root@milestone.local"
    )
    tenant = TenantCreate(name="Acme", slug="acme", adminEmail="admin@acme.local")
    assert tenant.admin_email == "admin@acme.local"
    with pytest.raises(ValidationError):
        StaffUpdate(email="not-an-email")
