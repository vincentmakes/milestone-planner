"""
Notes API router.
Handles notes operations.

Matches the Node.js API at /api/notes exactly.
"""

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.database import get_db
from app.middleware.auth import get_current_user, require_permission
from app.models.note import Note
from app.models.site import Site
from app.models.user import User
from app.schemas.note import (
    NoteCreate,
    NoteResponse,
)
from app.services.date_range import parse_day
from app.services.site_access import ensure_site_visible

router = APIRouter()


def build_note_response(note: Note) -> dict:
    """Build note response dict."""
    staff_name = note.staff.full_name if note.staff else None

    return {
        "id": note.id,
        "site_id": note.site_id,
        "staff_id": note.staff_id,
        "staff_name": staff_name,
        "date": note.date,
        "text": note.text,
        "type": note.type,
        "created_at": note.created_at,
    }


@router.get("/notes", response_model=list[NoteResponse])
async def get_notes(
    request: Request,
    siteId: int = Query(...),
    startDate: str | None = Query(None),
    endDate: str | None = Query(None),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """
    Get notes for a visible site (403 otherwise).

    Optionally filter by date range.

    Matches: GET /api/notes
    """
    await ensure_site_visible(request, db, user, siteId)
    query = select(Note).where(Note.site_id == siteId).options(selectinload(Note.staff))

    # Parsed (400 on junk): a raw string compared to a DATE column used to
    # reach asyncpg and come back as a DataError (500).
    if startDate:
        query = query.where(Note.date >= parse_day(startDate, "startDate"))
    if endDate:
        query = query.where(Note.date <= parse_day(endDate, "endDate"))

    query = query.order_by(Note.date)

    result = await db.execute(query)
    notes = result.scalars().all()

    return [build_note_response(note) for note in notes]


@router.post("/notes", response_model=NoteResponse, status_code=201)
async def create_note(
    data: NoteCreate,
    request: Request,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("staff_notes.manage")),
):
    """
    Create a new note.

    Requires ``staff_notes.manage``, at a visible site (403 otherwise).

    Matches: POST /api/notes
    """
    await ensure_site_visible(request, db, user, data.site_id)
    # Unknown references are a 404, not an FK violation (500).
    site = await db.execute(select(Site.id).where(Site.id == data.site_id))
    if site.scalar_one_or_none() is None:
        raise HTTPException(status_code=404, detail="Site not found")
    if data.staff_id is not None:
        staff = await db.execute(select(User.id).where(User.id == data.staff_id))
        if staff.scalar_one_or_none() is None:
            raise HTTPException(status_code=404, detail="Staff member not found")

    note = Note(
        site_id=data.site_id,
        staff_id=data.staff_id,
        date=data.date,
        text=data.text,
        type=data.type or "general",
    )

    db.add(note)
    await db.commit()
    await db.refresh(note)

    # Eager-load staff for response
    if note.staff_id:
        staff_result = await db.execute(select(User).where(User.id == note.staff_id))
        note.staff = staff_result.scalar_one_or_none()

    return build_note_response(note)


@router.delete("/notes/{note_id}")
async def delete_note(
    note_id: int,
    request: Request,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_permission("staff_notes.manage")),
):
    """
    Delete a note.

    Requires ``staff_notes.manage``, on a note of a visible site (403 otherwise).

    Matches: DELETE /api/notes/:id
    """
    result = await db.execute(select(Note).where(Note.id == note_id))
    note = result.scalar_one_or_none()

    if not note:
        raise HTTPException(status_code=404, detail="Note not found")
    await ensure_site_visible(request, db, user, note.site_id)

    await db.delete(note)
    await db.commit()

    return {"success": True}
