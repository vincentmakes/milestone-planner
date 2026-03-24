"""
Session model for express-session compatibility.
Maps to the sessions table used by both Node.js and Python backends.
"""

import json
from datetime import datetime
from typing import Any

from sqlalchemy import BigInteger, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class Session(Base):
    """
    Session storage compatible with express-session PostgreSQL store.

    This model must maintain exact compatibility with the Node.js
    express-session store to enable hybrid operation.
    """

    __tablename__ = "sessions"

    sid: Mapped[str] = mapped_column(String(255), primary_key=True)
    sess: Mapped[str] = mapped_column(Text, nullable=False)  # JSON blob
    expired: Mapped[int] = mapped_column(BigInteger, nullable=False)  # Unix timestamp ms

    @property
    def session_data(self) -> dict[str, Any]:
        """Parse session data from JSON."""
        try:
            return json.loads(self.sess)
        except json.JSONDecodeError:
            return {}

    @session_data.setter
    def session_data(self, data: dict[str, Any]) -> None:
        """Set session data as JSON string."""
        self.sess = json.dumps(data)

    @property
    def is_expired(self) -> bool:
        """Check if session has expired."""
        return self.expired < int(datetime.utcnow().timestamp() * 1000)

    @property
    def user(self) -> dict[str, Any] | None:
        """Get user data from session if present."""
        data = self.session_data
        return data.get("user")

    @property
    def user_id(self) -> int | None:
        """Get user ID from session if present."""
        user = self.user
        return user.get("id") if user else None

    @property
    def user_role(self) -> str | None:
        """Get user role from session if present."""
        user = self.user
        return user.get("role") if user else None

    def __repr__(self) -> str:
        return f"<Session {self.sid[:8]}... (expired: {self.is_expired})>"
