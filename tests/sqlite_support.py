"""
SQLite-backed sessions for the tests that need real SQL (no live PostgreSQL).

The suite is mock-based (tests/conftest.py); a few services are only
meaningful against a real query engine -- the metric loader's joins and
date filters, the dashboards router's visibility clause. These helpers give
them an in-memory SQLite database with every tenant table (CHECK constraints
dropped: some use PostgreSQL syntax) and foreign keys enforced, behind an
``AsyncSession``-shaped facade over a sync ``Session`` (aiosqlite is not a
dependency). The precedent is ``tests/test_approvals_followups.py``'s
``sqlite_db`` fixture.
"""

from collections.abc import Iterator
from contextlib import contextmanager
from typing import Any

from sqlalchemy import CheckConstraint, MetaData, create_engine, event
from sqlalchemy.orm import Session

import app.models  # noqa: F401  (registers every tenant table)
from app.database import Base


class AsyncSessionFacade:
    """Just enough of ``AsyncSession`` over a sync ``Session``."""

    def __init__(self, session: Session):
        self.session = session

    async def execute(self, statement: Any, params: Any = None) -> Any:
        if params is None:
            return self.session.execute(statement)
        return self.session.execute(statement, params)

    async def scalar(self, statement: Any) -> Any:
        return self.session.scalar(statement)

    async def scalars(self, statement: Any) -> Any:
        return self.session.scalars(statement)

    async def get(self, model: Any, ident: Any) -> Any:
        return self.session.get(model, ident)

    def add(self, instance: Any) -> None:
        self.session.add(instance)

    def add_all(self, instances: Any) -> None:
        self.session.add_all(instances)

    async def delete(self, instance: Any) -> None:
        self.session.delete(instance)

    async def flush(self) -> None:
        self.session.flush()

    async def commit(self) -> None:
        self.session.commit()

    async def rollback(self) -> None:
        self.session.rollback()

    async def refresh(self, instance: Any, attribute_names: Any = None) -> None:
        self.session.refresh(instance, attribute_names)

    async def close(self) -> None:
        self.session.close()


def _create_tables(engine: Any) -> None:
    metadata = MetaData()
    for table in Base.metadata.sorted_tables:
        copy = table.to_metadata(metadata)
        for constraint in [c for c in copy.constraints if isinstance(c, CheckConstraint)]:
            copy.constraints.discard(constraint)
    metadata.create_all(engine)


@contextmanager
def sqlite_session() -> Iterator[Session]:
    """A sync session on a fresh in-memory database holding every tenant table."""
    engine = create_engine("sqlite://")

    @event.listens_for(engine, "connect")
    def _foreign_keys(connection: Any, _record: Any) -> None:
        connection.execute("PRAGMA foreign_keys=ON")

    _create_tables(engine)
    with Session(engine, expire_on_commit=False) as session:
        yield session
    engine.dispose()
