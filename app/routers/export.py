"""
Export router for project exports.

Provides endpoints for:
- Exporting projects to MS Project XML format
- Exporting projects to CSV format

Uses MPXJ library for XML export when available.
"""

import csv
import io
import json
import os
import sys
import tempfile
from datetime import datetime, date, timedelta
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse, Response
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.database import get_db
from app.middleware.auth import require_superuser
from app.models.user import User
from app.models.project import Project, ProjectPhase, ProjectSubphase

router = APIRouter(tags=["export"])


def calculate_duration_days(start_date: date, end_date: date) -> int:
    """Calculate working days between two dates (simple calculation)."""
    if not start_date or not end_date:
        return 1
    delta = (end_date - start_date).days
    return max(1, delta)


def format_date_for_export(d: date) -> str:
    """Format date as MM/DD/YYYY for MS Project compatibility."""
    if not d:
        return ""
    if isinstance(d, str):
        d = datetime.fromisoformat(d).date()
    return d.strftime('%m/%d/%Y')


async def get_project_with_hierarchy(db: AsyncSession, project_id: int) -> Optional[Project]:
    """Load project with all phases and subphases."""
    result = await db.execute(
        select(Project)
        .options(selectinload(Project.phases))
        .where(Project.id == project_id)
    )
    project = result.scalar_one_or_none()
    
    if not project:
        return None
    
    # Load subphases for each phase
    for phase in project.phases:
        subphases_result = await db.execute(
            select(ProjectSubphase)
            .where(ProjectSubphase.parent_id == phase.id, ProjectSubphase.parent_type == 'phase')
            .order_by(ProjectSubphase.sort_order)
        )
        phase.subphases = list(subphases_result.scalars().all())
        
        # Recursively load nested subphases
        await load_nested_subphases(db, phase.subphases)
    
    return project


async def load_nested_subphases(db: AsyncSession, subphases: List[ProjectSubphase]):
    """Recursively load children of subphases."""
    for subphase in subphases:
        result = await db.execute(
            select(ProjectSubphase)
            .where(ProjectSubphase.parent_id == subphase.id, ProjectSubphase.parent_type == 'subphase')
            .order_by(ProjectSubphase.sort_order)
        )
        subphase.children = list(result.scalars().all())
        if subphase.children:
            await load_nested_subphases(db, subphase.children)


def build_task_list(project: Project) -> List[Dict[str, Any]]:
    """Build flat task list from project hierarchy for export."""
    tasks = []
    task_id = 1
    
    # Project summary task (level 1)
    project_notes = []
    if project.customer:
        project_notes.append(f"Customer: {project.customer}")
    if hasattr(project, 'pm') and project.pm:
        project_notes.append(f"PM: {project.pm.name}")
    
    tasks.append({
        'id': task_id,
        'name': project.name,
        'outline_level': 1,
        'start': project.start_date,
        'finish': project.end_date,
        'duration': calculate_duration_days(project.start_date, project.end_date),
        'predecessors': '',
        'percent_complete': 0,
        'milestone': False,
        'notes': '; '.join(project_notes) if project_notes else '',
    })
    task_id += 1
    
    # Sort phases by sort_order
    sorted_phases = sorted(project.phases, key=lambda p: p.sort_order or 0)
    
    # Add phases (level 2)
    for phase in sorted_phases:
        phase_completion = phase.completion if hasattr(phase, 'completion') and phase.completion else 0
        
        # Parse dependencies
        deps_str = ''
        if phase.dependencies:
            try:
                deps = json.loads(phase.dependencies) if isinstance(phase.dependencies, str) else phase.dependencies
                if deps:
                    deps_str = ','.join([f"{d.get('id', '')}{d.get('type', 'FS')}" for d in deps])
            except:
                pass
        
        tasks.append({
            'id': task_id,
            'name': phase.type,
            'outline_level': 2,
            'start': phase.start_date,
            'finish': phase.end_date,
            'duration': calculate_duration_days(phase.start_date, phase.end_date),
            'predecessors': deps_str,
            'percent_complete': phase_completion,
            'milestone': bool(phase.is_milestone),
            'notes': '',
        })
        phase_task_id = task_id
        task_id += 1
        
        # Add subphases recursively
        if hasattr(phase, 'subphases') and phase.subphases:
            task_id = add_subphases_to_list(tasks, phase.subphases, 3, task_id)
    
    return tasks


def add_subphases_to_list(tasks: List[Dict], subphases: List[ProjectSubphase], level: int, task_id: int) -> int:
    """Recursively add subphases to task list."""
    sorted_subphases = sorted(subphases, key=lambda s: s.sort_order or 0)
    
    for subphase in sorted_subphases:
        completion = subphase.completion if hasattr(subphase, 'completion') and subphase.completion else 0
        
        # Parse dependencies
        deps_str = ''
        if subphase.dependencies:
            try:
                deps = json.loads(subphase.dependencies) if isinstance(subphase.dependencies, str) else subphase.dependencies
                if deps:
                    deps_str = ','.join([f"{d.get('id', '')}{d.get('type', 'FS')}" for d in deps])
            except:
                pass
        
        tasks.append({
            'id': task_id,
            'name': subphase.name,
            'outline_level': level,
            'start': subphase.start_date,
            'finish': subphase.end_date,
            'duration': calculate_duration_days(subphase.start_date, subphase.end_date),
            'predecessors': deps_str,
            'percent_complete': completion,
            'milestone': bool(subphase.is_milestone),
            'notes': '',
        })
        task_id += 1
        
        # Add children recursively
        if hasattr(subphase, 'children') and subphase.children:
            task_id = add_subphases_to_list(tasks, subphase.children, level + 1, task_id)
    
    return task_id


def generate_csv(tasks: List[Dict[str, Any]], project_name: str) -> str:
    """Generate CSV content from task list."""
    output = io.StringIO()
    writer = csv.writer(output)
    
    # Header row
    writer.writerow([
        'ID', 'Name', 'Outline Level', 'Start', 'Finish', 
        'Duration', 'Predecessors', '% Complete', 'Milestone', 'Notes'
    ])
    
    # Data rows
    for task in tasks:
        writer.writerow([
            task['id'],
            task['name'],
            task['outline_level'],
            format_date_for_export(task['start']),
            format_date_for_export(task['finish']),
            f"{task['duration']}d",
            task['predecessors'],
            task['percent_complete'],
            'Yes' if task['milestone'] else 'No',
            task['notes'],
        ])
    
    return output.getvalue()


def generate_xml(tasks: List[Dict[str, Any]], project_name: str, project: Project) -> str:
    """Generate MS Project XML content from task list."""
    # Basic MS Project XML structure
    xml_lines = [
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
        '<Project xmlns="http://schemas.microsoft.com/project">',
        f'  <Name>{escape_xml(project_name)}</Name>',
        f'  <Title>{escape_xml(project_name)}</Title>',
        f'  <StartDate>{format_xml_date(project.start_date)}</StartDate>',
        f'  <FinishDate>{format_xml_date(project.end_date)}</FinishDate>',
        '  <CalendarUID>1</CalendarUID>',
        '  <Calendars>',
        '    <Calendar>',
        '      <UID>1</UID>',
        '      <Name>Standard</Name>',
        '      <IsBaseCalendar>true</IsBaseCalendar>',
        '    </Calendar>',
        '  </Calendars>',
        '  <Tasks>',
    ]
    
    for task in tasks:
        xml_lines.extend([
            '    <Task>',
            f'      <UID>{task["id"]}</UID>',
            f'      <ID>{task["id"]}</ID>',
            f'      <Name>{escape_xml(task["name"])}</Name>',
            f'      <OutlineLevel>{task["outline_level"]}</OutlineLevel>',
            f'      <Start>{format_xml_date(task["start"])}</Start>',
            f'      <Finish>{format_xml_date(task["finish"])}</Finish>',
            f'      <Duration>PT{task["duration"] * 8}H0M0S</Duration>',
            f'      <PercentComplete>{task["percent_complete"]}</PercentComplete>',
            f'      <Milestone>{"1" if task["milestone"] else "0"}</Milestone>',
            f'      <Notes>{escape_xml(task["notes"])}</Notes>',
            '    </Task>',
        ])
    
    xml_lines.extend([
        '  </Tasks>',
        '</Project>',
    ])
    
    return '\n'.join(xml_lines)


def escape_xml(text: str) -> str:
    """Escape special XML characters."""
    if not text:
        return ''
    return (str(text)
            .replace('&', '&amp;')
            .replace('<', '&lt;')
            .replace('>', '&gt;')
            .replace('"', '&quot;')
            .replace("'", '&apos;'))


def format_xml_date(d: date) -> str:
    """Format date for MS Project XML."""
    if not d:
        return ''
    if isinstance(d, str):
        d = datetime.fromisoformat(d).date()
    return f"{d.isoformat()}T08:00:00"


@router.post("/export/mpp/{project_id}")
async def export_project_to_mpp(
    project_id: int,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_superuser),
):
    """
    Export a project to MS Project XML format.
    
    Returns an XML file that can be imported into Microsoft Project.
    
    Matches: POST /api/export/mpp/:projectId
    """
    project = await get_project_with_hierarchy(db, project_id)
    
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    
    # Build task list
    tasks = build_task_list(project)
    
    # Generate XML
    xml_content = generate_xml(tasks, project.name, project)
    
    # Return as file download
    filename = f"{project.name.replace(' ', '_')}.xml"
    
    return Response(
        content=xml_content,
        media_type="application/xml",
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"'
        }
    )


@router.post("/export/csv/{project_id}")
async def export_project_to_csv(
    project_id: int,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_superuser),
):
    """
    Export a project to CSV format.
    
    Returns a CSV file compatible with MS Project import.
    
    Matches: POST /api/export/csv/:projectId
    """
    project = await get_project_with_hierarchy(db, project_id)
    
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    
    # Build task list
    tasks = build_task_list(project)
    
    # Generate CSV
    csv_content = generate_csv(tasks, project.name)
    
    # Return as file download
    filename = f"{project.name.replace(' ', '_')}.csv"
    
    return Response(
        content=csv_content,
        media_type="text/csv",
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"'
        }
    )


@router.get("/export/csv/{project_id}")
async def export_project_to_csv_get(
    project_id: int,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_superuser),
):
    """
    Export a project to CSV format (GET version for direct download).
    
    Returns a CSV file compatible with MS Project import.
    """
    return await export_project_to_csv(project_id, db, user)
