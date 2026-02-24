"""
Notes API router.
Handles notes operations.

Matches the Node.js API at /api/notes exactly.
"""

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.middleware.auth import get_current_user, require_superuser
from app.models.note import Note
from app.models.user import User
from app.schemas.note import (
    NoteCreate,
    NoteResponse,
)

router = APIRouter()


def build_note_response(note: Note) -> dict:
    """Build note response dict."""
    staff_name = None
    # Note: staff relationship not defined in Note model, query separately if needed

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
    siteId: int = Query(...),
    startDate: str | None = Query(None),
    endDate: str | None = Query(None),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """
    Get notes for a site.

    Optionally filter by date range.

    Matches: GET /api/notes
    """
    query = select(Note).where(Note.site_id == siteId)

    if startDate:
        query = query.where(Note.date >= startDate)
    if endDate:
        query = query.where(Note.date <= endDate)

    query = query.order_by(Note.date)

    result = await db.execute(query)
    notes = result.scalars().all()

    # Fetch staff names for notes with staff_id
    response = []
    for note in notes:
        note_dict = build_note_response(note)

        if note.staff_id:
            staff_result = await db.execute(select(User).where(User.id == note.staff_id))
            staff = staff_result.scalar_one_or_none()
            if staff:
                note_dict["staff_name"] = f"{staff.first_name} {staff.last_name}".strip()

        response.append(note_dict)

    return response


@router.post("/notes", response_model=NoteResponse, status_code=201)
async def create_note(
    data: NoteCreate,
    db: AsyncSession = Depends(get_db),
    superuser: User = Depends(require_superuser),
):
    """
    Create a new note.

    Requires superuser authentication.

    Matches: POST /api/notes
    """
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

    note_dict = build_note_response(note)

    # Fetch staff name if applicable
    if note.staff_id:
        staff_result = await db.execute(select(User).where(User.id == note.staff_id))
        staff = staff_result.scalar_one_or_none()
        if staff:
            note_dict["staff_name"] = f"{staff.first_name} {staff.last_name}".strip()

    return note_dict


@router.delete("/notes/{note_id}")
async def delete_note(
    note_id: int,
    db: AsyncSession = Depends(get_db),
    superuser: User = Depends(require_superuser),
):
    """
    Delete a note.

    Requires superuser authentication.

    Matches: DELETE /api/notes/:id
    """
    result = await db.execute(select(Note).where(Note.id == note_id))
    note = result.scalar_one_or_none()

    if not note:
        raise HTTPException(status_code=404, detail="Note not found")

    await db.delete(note)
    await db.commit()

    return {"success": True}
