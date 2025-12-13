"""
MPP Import router for Microsoft Project file imports.

Provides endpoints for:
- Testing MPXJ/JPype availability
- Importing MPP files and extracting project data
- Full project import (creates project with phases/subphases)

Note: This requires JPype and MPXJ to be installed.
The Node.js version spawns a Python subprocess; here we can use JPype directly.
"""

import csv
import io
import json
import os
import re
import sys
import tempfile
from datetime import datetime, date
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Form, Request
from fastapi.responses import JSONResponse
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.middleware.auth import require_admin, require_superuser
from app.models.user import User
from app.models.project import Project, ProjectPhase, ProjectSubphase

router = APIRouter(tags=["import"])


def check_mpxj_availability() -> Dict[str, Any]:
    """
    Check if JPype and MPXJ are available.
    Returns status information about the installation.
    """
    result = {
        "python_version": sys.version,
        "modules": {}
    }
    
    # Check JPype
    try:
        import jpype
        result["modules"]["jpype"] = getattr(jpype, '__version__', 'installed')
    except ImportError as e:
        result["modules"]["jpype"] = f"ERROR: {e}"
        return result
    
    # Check JVM
    try:
        import jpype.imports
        if not jpype.isJVMStarted():
            jpype.startJVM()
        result["modules"]["jvm"] = "started"
    except Exception as e:
        result["modules"]["jvm"] = f"ERROR: {e}"
        return result
    
    # Check MPXJ
    try:
        from net.sf.mpxj.reader import UniversalProjectReader
        result["modules"]["mpxj"] = "installed"
    except Exception as e:
        result["modules"]["mpxj"] = f"ERROR: {e}"
    
    return result


def parse_mpp_file(file_path: str) -> Dict[str, Any]:
    """
    Parse an MPP file using MPXJ and extract project data.
    
    Returns structured project data including tasks, resources, and assignments.
    """
    import jpype
    import jpype.imports
    
    # Start JVM if not already started
    if not jpype.isJVMStarted():
        jpype.startJVM()
    
    from net.sf.mpxj.reader import UniversalProjectReader
    
    reader = UniversalProjectReader()
    project = reader.read(file_path)
    
    # Extract project properties
    properties = project.getProjectProperties()
    project_data = {
        "name": str(properties.getName() or "Unnamed Project"),
        "author": str(properties.getAuthor() or ""),
        "company": str(properties.getCompany() or ""),
        "start_date": None,
        "finish_date": None,
        "tasks": [],
        "resources": [],
        "assignments": [],
    }
    
    # Get dates
    if properties.getStartDate():
        project_data["start_date"] = properties.getStartDate().toString()
    if properties.getFinishDate():
        project_data["finish_date"] = properties.getFinishDate().toString()
    
    # Extract tasks
    for task in project.getTasks():
        if task.getID() is None:
            continue
        
        task_data = {
            "id": int(task.getID()),
            "unique_id": int(task.getUniqueID()) if task.getUniqueID() else None,
            "name": str(task.getName() or ""),
            "start": task.getStart().toString() if task.getStart() else None,
            "finish": task.getFinish().toString() if task.getFinish() else None,
            "duration": str(task.getDuration()) if task.getDuration() else None,
            "percent_complete": float(task.getPercentageComplete() or 0),
            "outline_level": int(task.getOutlineLevel() or 0),
            "parent_id": int(task.getParentTask().getID()) if task.getParentTask() and task.getParentTask().getID() else None,
            "milestone": bool(task.getMilestone()),
            "summary": bool(task.getSummary()),
            "notes": str(task.getNotes() or ""),
        }
        
        # Get predecessors
        preds = task.getPredecessors()
        if preds:
            pred_list = []
            for pred in preds:
                pred_task = pred.getTargetTask()
                if pred_task and pred_task.getID():
                    pred_list.append({
                        "id": int(pred_task.getID()),
                        "type": str(pred.getType()) if pred.getType() else "FS"
                    })
            task_data["predecessors"] = pred_list
        else:
            task_data["predecessors"] = []
            
        project_data["tasks"].append(task_data)
    
    # Extract resources
    for resource in project.getResources():
        if resource.getID() is None:
            continue
        
        resource_data = {
            "id": int(resource.getID()),
            "unique_id": int(resource.getUniqueID()) if resource.getUniqueID() else None,
            "name": str(resource.getName() or ""),
            "type": str(resource.getType()) if resource.getType() else None,
            "email": str(resource.getEmailAddress() or ""),
            "max_units": float(resource.getMaxUnits() or 100),
        }
        project_data["resources"].append(resource_data)
    
    # Extract assignments
    for assignment in project.getResourceAssignments():
        task = assignment.getTask()
        resource = assignment.getResource()
        
        if not task or not resource:
            continue
        
        assignment_data = {
            "task_id": int(task.getID()) if task.getID() else None,
            "resource_id": int(resource.getID()) if resource.getID() else None,
            "units": float(assignment.getUnits() or 100),
            "start": assignment.getStart().toString() if assignment.getStart() else None,
            "finish": assignment.getFinish().toString() if assignment.getFinish() else None,
        }
        project_data["assignments"].append(assignment_data)
    
    return project_data


def parse_csv_file(content: str) -> Dict[str, Any]:
    """
    Parse a CSV file (MS Project export format) and extract project data.
    
    Returns structured project data similar to MPP parser output.
    """
    # Remove BOM if present
    if content.startswith('\ufeff'):
        content = content[1:]
    
    # Parse CSV
    reader = csv.reader(io.StringIO(content))
    rows = list(reader)
    
    if len(rows) < 2:
        raise ValueError("CSV file is empty or has no data rows")
    
    # Find column indices from header row
    header = [h.lower().strip() for h in rows[0]]
    cols = {
        'id': header.index('id') if 'id' in header else -1,
        'name': header.index('name') if 'name' in header else -1,
        'start': header.index('start') if 'start' in header else -1,
        'finish': header.index('finish') if 'finish' in header else -1,
        'duration': header.index('duration') if 'duration' in header else -1,
        'predecessors': header.index('predecessors') if 'predecessors' in header else -1,
        'percent_complete': header.index('% complete') if '% complete' in header else -1,
        'outline_level': header.index('outline level') if 'outline level' in header else -1,
        'notes': header.index('notes') if 'notes' in header else -1,
        'milestone': header.index('milestone') if 'milestone' in header else -1,
    }
    
    # Validate required columns
    if cols['name'] == -1 or cols['start'] == -1 or cols['finish'] == -1:
        raise ValueError("CSV must have Name, Start, and Finish columns")
    
    project_data = {
        "name": "Imported Project",
        "start_date": None,
        "finish_date": None,
        "tasks": [],
    }
    
    # Parse data rows
    for i, row in enumerate(rows[1:], start=1):
        if not row or len(row) <= max(c for c in cols.values() if c >= 0):
            continue
        
        if cols['name'] >= 0 and cols['name'] < len(row):
            name = row[cols['name']].strip()
        else:
            continue
            
        if not name:
            continue
        
        task_id = i
        if cols['id'] >= 0 and cols['id'] < len(row) and row[cols['id']].strip():
            try:
                task_id = int(row[cols['id']])
            except ValueError:
                pass
        
        start = None
        if cols['start'] >= 0 and cols['start'] < len(row) and row[cols['start']].strip():
            start = parse_date_str(row[cols['start']].strip())
        
        finish = None
        if cols['finish'] >= 0 and cols['finish'] < len(row) and row[cols['finish']].strip():
            finish = parse_date_str(row[cols['finish']].strip())
        
        outline_level = 1
        if cols['outline_level'] >= 0 and cols['outline_level'] < len(row) and row[cols['outline_level']].strip():
            try:
                outline_level = int(row[cols['outline_level']])
            except ValueError:
                pass
        
        # Parse predecessors
        predecessors = []
        if cols['predecessors'] >= 0 and cols['predecessors'] < len(row) and row[cols['predecessors']].strip():
            pred_str = row[cols['predecessors']].strip()
            for part in re.split(r'[;,]', pred_str):
                match = re.match(r'(\d+)\s*(FS|FF|SS|SF)?', part.strip(), re.IGNORECASE)
                if match:
                    predecessors.append({
                        "id": int(match.group(1)),
                        "type": (match.group(2) or "FS").upper()
                    })
        
        # Parse percent complete
        percent_complete = 0
        if cols['percent_complete'] >= 0 and cols['percent_complete'] < len(row) and row[cols['percent_complete']].strip():
            try:
                percent_complete = int(row[cols['percent_complete']].strip().rstrip('%'))
            except ValueError:
                pass
        
        # Parse milestone
        is_milestone = False
        if cols['milestone'] >= 0 and cols['milestone'] < len(row) and row[cols['milestone']].strip().lower() in ('yes', 'true', '1'):
            is_milestone = True
        
        # Parse notes
        notes = ""
        if cols['notes'] >= 0 and cols['notes'] < len(row):
            notes = row[cols['notes']].strip()
        
        task_data = {
            "id": task_id,
            "name": name,
            "start": start,
            "finish": finish,
            "outline_level": outline_level,
            "predecessors": predecessors,
            "percent_complete": percent_complete,
            "milestone": is_milestone,
            "notes": notes,
            "parent_id": None,  # Will be computed from outline_level
        }
        
        project_data["tasks"].append(task_data)
    
    # Compute parent_id from outline_level
    task_stack = []
    for task in project_data["tasks"]:
        level = task["outline_level"]
        
        # Pop stack until we find parent level
        while task_stack and task_stack[-1]["outline_level"] >= level:
            task_stack.pop()
        
        if task_stack:
            task["parent_id"] = task_stack[-1]["id"]
        
        task_stack.append(task)
    
    # Find project row (level 1) for name and dates
    for task in project_data["tasks"]:
        if task["outline_level"] == 1:
            project_data["name"] = task["name"]
            project_data["start_date"] = task["start"]
            project_data["finish_date"] = task["finish"]
            # Extract customer from notes if present
            if task["notes"]:
                match = re.search(r'Customer:\s*([^;]+)', task["notes"], re.IGNORECASE)
                if match:
                    project_data["customer"] = match.group(1).strip()
            break
    
    return project_data


def parse_date_str(date_str: str) -> Optional[date]:
    """Parse various date formats and return date object."""
    if not date_str:
        return None
    
    # If already a date object
    if isinstance(date_str, date):
        return date_str
    
    # Try ISO format first
    try:
        return datetime.fromisoformat(date_str.replace('Z', '+00:00')).date()
    except ValueError:
        pass
    
    # Try common formats
    formats = [
        '%m/%d/%Y', '%d/%m/%Y', '%Y-%m-%d',
        '%m/%d/%y', '%d/%m/%y',
        '%B %d, %Y', '%b %d, %Y',
    ]
    
    for fmt in formats:
        try:
            return datetime.strptime(date_str, fmt).date()
        except ValueError:
            continue
    
    # Last resort: try Python's parser
    try:
        from dateutil import parser
        return parser.parse(date_str).date()
    except:
        return None


@router.get("/import/mpp/test")
async def test_mpp_import(
    user: User = Depends(require_superuser),
):
    """
    Test if MPP import functionality is available.
    
    Checks for JPype, JVM, and MPXJ library availability.
    
    Matches: GET /api/import/mpp/test
    """
    try:
        result = check_mpxj_availability()
        return {"success": True, **result}
    except Exception as e:
        return JSONResponse(
            status_code=500,
            content={"success": False, "error": str(e)}
        )


@router.post("/import/mpp")
async def import_mpp_file(
    file: UploadFile = File(...),
    user: User = Depends(require_superuser),
):
    """
    Import a Microsoft Project (MPP) file.
    
    Parses the uploaded MPP file and returns the extracted project data
    including tasks, resources, and assignments.
    
    Matches: POST /api/import/mpp
    """
    # Validate file
    if not file.filename:
        raise HTTPException(status_code=400, detail="No file provided")
    
    if not file.filename.lower().endswith(('.mpp', '.mpt', '.mpx', '.xml')):
        raise HTTPException(
            status_code=400,
            detail="Invalid file type. Supported: .mpp, .mpt, .mpx, .xml"
        )
    
    # Save to temp file
    temp_file = None
    try:
        # Create temp file with appropriate extension
        suffix = os.path.splitext(file.filename)[1]
        temp_file = tempfile.NamedTemporaryFile(delete=False, suffix=suffix)
        
        # Write uploaded content
        content = await file.read()
        if not content:
            raise HTTPException(status_code=400, detail="Empty file")
        
        temp_file.write(content)
        temp_file.close()
        
        # Parse the file
        project_data = parse_mpp_file(temp_file.name)
        
        return {
            "success": True,
            "filename": file.filename,
            "project": project_data,
        }
        
    except HTTPException:
        raise
    except Exception as e:
        return JSONResponse(
            status_code=500,
            content={"success": False, "error": str(e)}
        )
    finally:
        # Clean up temp file
        if temp_file and os.path.exists(temp_file.name):
            try:
                os.unlink(temp_file.name)
            except:
                pass


@router.get("/import/test")
async def test_import_endpoint():
    """Simple test endpoint to verify routing works."""
    return {"status": "ok", "message": "Import endpoint is reachable"}


@router.post("/import/test-upload")
async def test_upload_endpoint(
    file: UploadFile = File(...),
):
    """Test file upload without authentication."""
    content = await file.read()
    return {
        "status": "ok",
        "filename": file.filename,
        "size": len(content),
    }


@router.post("/import/project")
async def import_project_full(
    file: UploadFile = File(...),
    site_id: str = Form(""),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_superuser),
):
    """
    Full project import - parses file and creates project with all phases/subphases.
    
    Supports both MPP and CSV files.
    Creates project, phases, and nested subphases in the database.
    
    Matches: POST /api/import/project
    """
    import logging
    logger = logging.getLogger(__name__)
    
    # Parse site_id from string
    parsed_site_id: Optional[int] = None
    if site_id and site_id.strip():
        try:
            parsed_site_id = int(site_id)
        except ValueError:
            pass
    
    logger.info(f"Import request received: {file.filename}, site_id: {parsed_site_id}")
    print(f"Import request received: {file.filename}, site_id: {parsed_site_id}")
    
    if not file.filename:
        raise HTTPException(status_code=400, detail="No file provided")
    
    filename_lower = file.filename.lower()
    content = await file.read()
    
    logger.info(f"File size: {len(content)} bytes")
    print(f"File size: {len(content)} bytes")
    
    if not content:
        raise HTTPException(status_code=400, detail="Empty file")
    
    temp_file = None
    
    try:
        # Parse based on file type
        if filename_lower.endswith('.csv'):
            # Parse CSV directly
            text_content = content.decode('utf-8-sig')  # Handle BOM
            project_data = parse_csv_file(text_content)
        elif filename_lower.endswith(('.mpp', '.mpt', '.mpx', '.xml')):
            # Save to temp file for MPXJ
            suffix = os.path.splitext(file.filename)[1]
            temp_file = tempfile.NamedTemporaryFile(delete=False, suffix=suffix)
            temp_file.write(content)
            temp_file.close()
            
            project_data = parse_mpp_file(temp_file.name)
        else:
            raise HTTPException(
                status_code=400,
                detail="Invalid file type. Supported: .csv, .mpp, .mpt, .mpx, .xml"
            )
        
        # Create project
        project = Project(
            name=project_data.get("name", "Imported Project"),
            site_id=parsed_site_id,
            customer=project_data.get("customer"),
            start_date=parse_date_str(project_data.get("start_date")) if project_data.get("start_date") else date.today(),
            end_date=parse_date_str(project_data.get("finish_date")) if project_data.get("finish_date") else date.today(),
            notes=f"Imported from {file.filename}",
        )
        
        db.add(project)
        await db.flush()
        
        project_id = project.id
        
        # Build task hierarchy
        tasks = project_data.get("tasks", [])
        if not tasks:
            await db.commit()
            return {
                "success": True,
                "project_id": project_id,
                "project_name": project.name,
                "phases_created": 0,
                "subphases_created": 0,
            }
        
        # Filter out project-level task (level 1)
        work_tasks = [t for t in tasks if t.get("outline_level", 1) > 1]
        
        # Create phases and subphases
        csv_id_to_db = {}  # Map CSV task ID to {db_id, type}
        phases_created = 0
        subphases_created = 0
        
        # First pass: create phases (level 2)
        phase_order = 0
        for task in work_tasks:
            if task.get("outline_level") == 2:
                phase = ProjectPhase(
                    project_id=project_id,
                    type=task["name"],
                    start_date=parse_date_str(task.get("start")) or project.start_date,
                    end_date=parse_date_str(task.get("finish")) or project.end_date,
                    is_milestone=1 if task.get("milestone") else 0,
                    sort_order=phase_order,
                    completion=task.get("percent_complete", 0),
                )
                db.add(phase)
                await db.flush()
                
                csv_id_to_db[task["id"]] = {"db_id": phase.id, "type": "phase"}
                phase_order += 1
                phases_created += 1
        
        # Second pass: create subphases (level 3+) recursively
        async def create_subphases_for_parent(parent_id: int, parent_type: str, parent_csv_id: int, depth: int = 1):
            nonlocal subphases_created
            
            # Find children of this parent
            children = [t for t in work_tasks 
                       if t.get("parent_id") == parent_csv_id and t.get("outline_level", 1) > 2]
            
            order = 0
            for child in children:
                subphase = ProjectSubphase(
                    parent_id=parent_id,
                    parent_type=parent_type,
                    project_id=project_id,
                    name=child["name"],
                    start_date=parse_date_str(child.get("start")) or project.start_date,
                    end_date=parse_date_str(child.get("finish")) or project.end_date,
                    is_milestone=1 if child.get("milestone") else 0,
                    sort_order=order,
                    depth=depth,
                    completion=child.get("percent_complete", 0),
                )
                db.add(subphase)
                await db.flush()
                
                csv_id_to_db[child["id"]] = {"db_id": subphase.id, "type": "subphase"}
                subphases_created += 1
                order += 1
                
                # Recursively create children
                await create_subphases_for_parent(subphase.id, "subphase", child["id"], depth + 1)
        
        # Create subphases for each phase
        for task in work_tasks:
            if task.get("outline_level") == 2:
                phase_info = csv_id_to_db.get(task["id"])
                if phase_info:
                    await create_subphases_for_parent(
                        phase_info["db_id"], 
                        "phase", 
                        task["id"]
                    )
        
        # Third pass: update dependencies
        for task in work_tasks:
            if not task.get("predecessors"):
                continue
            
            task_info = csv_id_to_db.get(task["id"])
            if not task_info:
                continue
            
            # Map predecessor CSV IDs to DB IDs
            deps = []
            for pred in task["predecessors"]:
                pred_info = csv_id_to_db.get(pred["id"])
                if pred_info:
                    deps.append({
                        "id": pred_info["db_id"],
                        "type": pred.get("type", "FS")
                    })
            
            if deps:
                deps_json = json.dumps(deps)
                if task_info["type"] == "phase":
                    # Update phase
                    phase = await db.get(ProjectPhase, task_info["db_id"])
                    if phase:
                        phase.dependencies = deps_json
                else:
                    # Update subphase
                    subphase = await db.get(ProjectSubphase, task_info["db_id"])
                    if subphase:
                        subphase.dependencies = deps_json
        
        await db.commit()
        
        return {
            "success": True,
            "project_id": project_id,
            "project_name": project.name,
            "phases_created": phases_created,
            "subphases_created": subphases_created,
        }
        
    except HTTPException:
        raise
    except Exception as e:
        import traceback
        import logging
        logger = logging.getLogger(__name__)
        logger.error(f"Import failed: {str(e)}")
        logger.error(traceback.format_exc())
        await db.rollback()
        return JSONResponse(
            status_code=500,
            content={"success": False, "error": str(e)}
        )
    finally:
        # Clean up temp file
        if temp_file and os.path.exists(temp_file.name):
            try:
                os.unlink(temp_file.name)
            except:
                pass

