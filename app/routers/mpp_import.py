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
import logging
import os
import re
import sys
import tempfile
from datetime import date, datetime
from typing import Any

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import JSONResponse
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.middleware.auth import require_superuser
from app.models.project import Project, ProjectPhase, ProjectSubphase
from app.models.user import User

router = APIRouter(tags=["import"])
logger = logging.getLogger(__name__)


def find_java_home() -> str | None:
    """
    Try to find JAVA_HOME from various common locations.
    Returns the path if found, None otherwise.
    """
    # First check if JAVA_HOME is already set
    java_home = os.environ.get("JAVA_HOME")
    if java_home and os.path.exists(java_home):
        return java_home

    # Common Java installation paths to check
    java_paths = [
        # Docker/Debian default
        "/usr/lib/jvm/default-java",
        "/usr/lib/jvm/java-17-openjdk-amd64",
        "/usr/lib/jvm/java-11-openjdk-amd64",
        "/usr/lib/jvm/java-21-openjdk-amd64",
        # Ubuntu/Debian alternatives
        "/usr/lib/jvm/java-17-openjdk",
        "/usr/lib/jvm/java-11-openjdk",
        # WSL with Windows Java
        "/mnt/c/Program Files/Java/jdk-17",
        "/mnt/c/Program Files/Java/jdk-21",
        "/mnt/c/Program Files/Eclipse Adoptium/jdk-17.0.9.9-hotspot",
        "/mnt/c/Program Files/Eclipse Adoptium/jdk-21.0.1.12-hotspot",
        # macOS
        "/Library/Java/JavaVirtualMachines/temurin-17.jdk/Contents/Home",
        "/Library/Java/JavaVirtualMachines/temurin-21.jdk/Contents/Home",
        "/opt/homebrew/opt/openjdk/libexec/openjdk.jdk/Contents/Home",
    ]

    for path in java_paths:
        if os.path.exists(path):
            # Verify it has a valid structure (bin/java exists)
            java_bin = os.path.join(path, "bin", "java")
            if os.path.exists(java_bin) or os.path.exists(java_bin + ".exe"):
                return path

    # Try to find Java using 'which' command on Unix
    try:
        import subprocess

        result = subprocess.run(["which", "java"], capture_output=True, text=True)
        if result.returncode == 0:
            java_path = result.stdout.strip()
            # Follow symlinks to find real path
            real_path = os.path.realpath(java_path)
            # Go up from bin/java to JAVA_HOME
            if "/bin/java" in real_path:
                java_home = real_path.replace("/bin/java", "")
                if os.path.exists(java_home):
                    return java_home
    except Exception:
        pass

    return None


def find_jvm_library(java_home: str) -> str | None:
    """
    Find the JVM shared library (libjvm.so or jvm.dll) within JAVA_HOME.
    """
    if not java_home:
        return None

    # Common locations for libjvm.so / jvm.dll
    lib_patterns = [
        # Linux
        "lib/server/libjvm.so",
        "lib/amd64/server/libjvm.so",
        "jre/lib/amd64/server/libjvm.so",
        "lib/libjvm.so",
        # macOS
        "lib/server/libjvm.dylib",
        "lib/libjvm.dylib",
        # Windows
        "bin/server/jvm.dll",
        "jre/bin/server/jvm.dll",
    ]

    for pattern in lib_patterns:
        full_path = os.path.join(java_home, pattern)
        if os.path.exists(full_path):
            return full_path

    return None


def get_jvm_setup_instructions() -> str:
    """Return platform-specific instructions for setting up Java and MPXJ."""
    return """
Java & MPXJ Setup Required for MPP Import
==========================================

MPP file import requires Java and the mpxj Python package.

Step 1: Install Java
--------------------
For WSL/Ubuntu:
  sudo apt update
  sudo apt install default-jre-headless

For macOS:
  brew install openjdk

For Windows (with WSL):
  Install Java in WSL using the Ubuntu command above.

Step 2: Install MPXJ Python Package
-----------------------------------
  pip install mpxj

This package bundles the MPXJ Java library for parsing MS Project files.

Step 3: Restart the Server
--------------------------
After installation, restart the Python server.

Docker deployment handles all of this automatically.
"""


def find_mpxj_jar() -> str | None:
    """
    Find the MPXJ JAR file from the mpxj Python package.
    Returns the path to the JAR file or None if not found.
    """
    try:
        import mpxj

        # The mpxj package includes the JAR file
        mpxj_dir = os.path.dirname(mpxj.__file__)

        # Look for the JAR file in the mpxj package directory
        for filename in os.listdir(mpxj_dir):
            if filename.endswith(".jar") and "mpxj" in filename.lower():
                jar_path = os.path.join(mpxj_dir, filename)
                logger.info(f"Found MPXJ JAR: {jar_path}")
                return jar_path

        # Also check in a 'lib' subdirectory
        lib_dir = os.path.join(mpxj_dir, "lib")
        if os.path.exists(lib_dir):
            for filename in os.listdir(lib_dir):
                if filename.endswith(".jar"):
                    jar_path = os.path.join(lib_dir, filename)
                    logger.info(f"Found JAR in lib: {jar_path}")
                    return jar_path

        logger.warning(f"No JAR file found in mpxj package at {mpxj_dir}")
        return None
    except ImportError:
        logger.warning("mpxj Python package not installed")
        return None
    except Exception as e:
        logger.warning(f"Error finding MPXJ JAR: {e}")
        return None


def get_mpxj_classpath() -> str:
    """
    Get the classpath for MPXJ including all required JARs.
    Uses the mpxj Python package which bundles all necessary JARs.
    """
    try:
        import mpxj

        mpxj_dir = os.path.dirname(mpxj.__file__)

        # Collect all JAR files from the mpxj package
        jar_files = []

        # Check root directory
        for filename in os.listdir(mpxj_dir):
            if filename.endswith(".jar"):
                jar_files.append(os.path.join(mpxj_dir, filename))

        # Check lib subdirectory
        lib_dir = os.path.join(mpxj_dir, "lib")
        if os.path.exists(lib_dir):
            for filename in os.listdir(lib_dir):
                if filename.endswith(".jar"):
                    jar_files.append(os.path.join(lib_dir, filename))

        if jar_files:
            classpath = os.pathsep.join(jar_files)
            logger.info(f"MPXJ classpath: {classpath}")
            return classpath

        logger.warning("No JAR files found in mpxj package")
        return ""
    except ImportError:
        logger.warning("mpxj Python package not installed - install with: pip install mpxj")
        return ""
    except Exception as e:
        logger.warning(f"Error building MPXJ classpath: {e}")
        return ""


def ensure_jvm_started() -> None:
    """
    Ensure the JVM is started with proper configuration.
    Raises a detailed HTTPException if Java is not available.

    IMPORTANT: The mpxj package must be imported BEFORE jpype.startJVM() is called.
    The mpxj package automatically adds its JARs to the classpath on import.
    """
    import jpype

    if jpype.isJVMStarted():
        return

    # CRITICAL: Import mpxj BEFORE starting JVM - it adds JARs to classpath
    try:
        import mpxj

        logger.info(f"mpxj package loaded from: {mpxj.__file__}")
    except ImportError as e:
        logger.error(f"mpxj package not installed: {e}")
        raise HTTPException(
            status_code=500,
            detail=f"""mpxj Python package not installed.

Install with: pip install mpxj

{get_jvm_setup_instructions()}""",
        ) from e

    # Now import jpype.imports after mpxj
    import jpype.imports

    # Try to find Java
    java_home = find_java_home()
    jvm_path = None

    if java_home:
        logger.info(f"Found JAVA_HOME: {java_home}")
        os.environ["JAVA_HOME"] = java_home
        jvm_path = find_jvm_library(java_home)
        if jvm_path:
            logger.info(f"Found JVM library: {jvm_path}")

    try:
        # Start JVM - mpxj has already added its JARs to the classpath
        if jvm_path:
            jpype.startJVM(jvm_path)
        else:
            jpype.startJVM()

        logger.info("JVM started successfully")

        # Verify MPXJ is accessible - try both old and new package names
        try:
            # Try new package name first (mpxj 10+)
            from org.mpxj.reader import UniversalProjectReader  # noqa: F401

            logger.info("MPXJ loaded successfully (org.mpxj)")
        except ImportError:
            try:
                # Fall back to old package name
                from net.sf.mpxj.reader import UniversalProjectReader  # noqa: F401

                logger.info("MPXJ loaded successfully (net.sf.mpxj)")
            except ImportError as e:
                logger.error(f"MPXJ not accessible: {e}")
                raise HTTPException(
                    status_code=500,
                    detail=f"""MPXJ Java library not found in classpath.

Error: {e}

This usually means the mpxj Python package isn't properly installed.
Try reinstalling: pip install --force-reinstall mpxj

{get_jvm_setup_instructions()}""",
                ) from e

    except Exception as e:
        error_msg = str(e)
        logger.error(f"Failed to start JVM: {error_msg}")

        # Provide helpful error message
        if "libjvm.so" in error_msg or "JVMNotFoundException" in str(type(e)):
            detail = f"""Java/JVM not found. MPP import requires Java to be installed.

Error: {error_msg}

{get_jvm_setup_instructions()}

Current environment:
- JAVA_HOME: {os.environ.get("JAVA_HOME", "Not set")}
- Detected Java: {java_home or "Not found"}
- JVM Library: {jvm_path or "Not found"}
"""
            raise HTTPException(status_code=500, detail=detail) from e
        raise


def check_mpxj_availability() -> dict[str, Any]:
    """
    Check if JPype and MPXJ are available.
    Returns status information about the installation.
    """
    result = {
        "python_version": sys.version,
        "java_home": os.environ.get("JAVA_HOME"),
        "detected_java": find_java_home(),
        "modules": {},
        "setup_instructions": None,
    }

    # Check JPype
    try:
        import jpype

        result["modules"]["jpype"] = getattr(jpype, "__version__", "installed")
    except ImportError as e:
        result["modules"]["jpype"] = f"ERROR: {e}"
        result["setup_instructions"] = "Install jpype1: pip install jpype1"
        return result

    # Check mpxj Python package
    try:
        import mpxj

        mpxj_dir = os.path.dirname(mpxj.__file__)
        jar_count = len([f for f in os.listdir(mpxj_dir) if f.endswith(".jar")])
        lib_dir = os.path.join(mpxj_dir, "lib")
        if os.path.exists(lib_dir):
            jar_count += len([f for f in os.listdir(lib_dir) if f.endswith(".jar")])
        result["modules"]["mpxj_package"] = f"installed ({jar_count} JARs found)"
        result["mpxj_classpath"] = get_mpxj_classpath()
    except ImportError:
        result["modules"]["mpxj_package"] = "ERROR: Not installed"
        result["setup_instructions"] = "Install mpxj: pip install mpxj"
        return result

    # Check JVM
    try:
        import jpype.imports

        ensure_jvm_started()
        result["modules"]["jvm"] = "started"
    except HTTPException:
        result["modules"]["jvm"] = "ERROR: Java not found"
        result["setup_instructions"] = get_jvm_setup_instructions()
        return result
    except Exception as e:
        result["modules"]["jvm"] = f"ERROR: {e}"
        result["setup_instructions"] = get_jvm_setup_instructions()
        return result

    # Check MPXJ
    try:
        # Try new package name first (mpxj 10+)
        from org.mpxj.reader import UniversalProjectReader  # noqa: F401

        result["modules"]["mpxj"] = "installed (org.mpxj)"
    except ImportError:
        try:
            # Fall back to old package name
            result["modules"]["mpxj"] = "installed (net.sf.mpxj)"
        except Exception as e:
            result["modules"]["mpxj"] = f"ERROR: {e}"
            result["setup_instructions"] = (
                "MPXJ should be automatically available via the mpxj Python package. Try: pip install --force-reinstall mpxj"
            )

    return result


def parse_mpp_file(file_path: str) -> dict[str, Any]:
    """
    Parse an MPP file using MPXJ and extract project data.

    Returns structured project data including tasks, resources, and assignments.
    """

    # Start JVM if not already started (with proper error handling)
    ensure_jvm_started()

    # Try to import UniversalProjectReader - handle both old and new package names
    try:
        from org.mpxj.reader import UniversalProjectReader
    except ImportError:
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

    # Get dates - handle Java LocalDateTime objects
    def java_date_to_str(java_date):
        """Convert Java date object to ISO string."""
        if java_date is None:
            return None
        # Handle Java LocalDate/LocalDateTime
        if (
            hasattr(java_date, "getYear")
            and hasattr(java_date, "getMonthValue")
            and hasattr(java_date, "getDayOfMonth")
        ):
            year = int(java_date.getYear())
            month = int(java_date.getMonthValue())
            day = int(java_date.getDayOfMonth())
            return f"{year:04d}-{month:02d}-{day:02d}"
        # Otherwise convert to string
        return str(java_date)

    if properties.getStartDate():
        project_data["start_date"] = java_date_to_str(properties.getStartDate())
    if properties.getFinishDate():
        project_data["finish_date"] = java_date_to_str(properties.getFinishDate())

    # Extract tasks
    for task in project.getTasks():
        if task.getID() is None:
            continue

        task_data = {
            "id": int(task.getID()),
            "unique_id": int(task.getUniqueID()) if task.getUniqueID() else None,
            "name": str(task.getName() or ""),
            "start": java_date_to_str(task.getStart()) if task.getStart() else None,
            "finish": java_date_to_str(task.getFinish()) if task.getFinish() else None,
            "duration": str(task.getDuration()) if task.getDuration() else None,
            "percent_complete": float(task.getPercentageComplete() or 0),
            "outline_level": int(task.getOutlineLevel() or 0),
            "parent_id": int(task.getParentTask().getID())
            if task.getParentTask() and task.getParentTask().getID()
            else None,
            "milestone": bool(task.getMilestone()),
            "summary": bool(task.getSummary()),
            "notes": str(task.getNotes() or ""),
        }

        # Get predecessors
        preds = task.getPredecessors()
        if preds:
            pred_list = []
            for pred in preds:
                # Handle both old and new MPXJ API
                # Old: getTargetTask() / getSourceTask()
                # New (15+): getPredecessorTask() / getSuccessorTask()
                try:
                    # Try new API first (MPXJ 15+)
                    pred_task = pred.getPredecessorTask()
                except AttributeError:
                    try:
                        # Fall back to old API
                        pred_task = pred.getTargetTask()
                    except AttributeError:
                        pred_task = None

                if pred_task and pred_task.getID():
                    # Get relation type - handle potential enum
                    rel_type = pred.getType()
                    if rel_type:
                        rel_type_str = str(rel_type)
                        # Clean up enum string (e.g., "FINISH_START" -> "FS")
                        if "FINISH_START" in rel_type_str or rel_type_str == "FS":
                            rel_type_str = "FS"
                        elif "START_START" in rel_type_str or rel_type_str == "SS":
                            rel_type_str = "SS"
                        elif "FINISH_FINISH" in rel_type_str or rel_type_str == "FF":
                            rel_type_str = "FF"
                        elif "START_FINISH" in rel_type_str or rel_type_str == "SF":
                            rel_type_str = "SF"
                        else:
                            rel_type_str = "FS"  # Default
                    else:
                        rel_type_str = "FS"

                    pred_list.append({"id": int(pred_task.getID()), "type": rel_type_str})
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
            "start": java_date_to_str(assignment.getStart()) if assignment.getStart() else None,
            "finish": java_date_to_str(assignment.getFinish()) if assignment.getFinish() else None,
        }
        project_data["assignments"].append(assignment_data)

    return project_data


def parse_csv_file(content: str) -> dict[str, Any]:
    """
    Parse a CSV file (MS Project export format) and extract project data.

    Returns structured project data similar to MPP parser output.
    """
    # Remove BOM if present
    if content.startswith("\ufeff"):
        content = content[1:]

    # Parse CSV
    reader = csv.reader(io.StringIO(content))
    rows = list(reader)

    if len(rows) < 2:
        raise ValueError("CSV file is empty or has no data rows")

    # Find column indices from header row
    header = [h.lower().strip() for h in rows[0]]
    cols = {
        "id": header.index("id") if "id" in header else -1,
        "name": header.index("name") if "name" in header else -1,
        "start": header.index("start") if "start" in header else -1,
        "finish": header.index("finish") if "finish" in header else -1,
        "duration": header.index("duration") if "duration" in header else -1,
        "predecessors": header.index("predecessors") if "predecessors" in header else -1,
        "percent_complete": header.index("% complete") if "% complete" in header else -1,
        "outline_level": header.index("outline level") if "outline level" in header else -1,
        "notes": header.index("notes") if "notes" in header else -1,
        "milestone": header.index("milestone") if "milestone" in header else -1,
    }

    # Validate required columns
    if cols["name"] == -1 or cols["start"] == -1 or cols["finish"] == -1:
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

        if cols["name"] >= 0 and cols["name"] < len(row):
            name = row[cols["name"]].strip()
        else:
            continue

        if not name:
            continue

        task_id = i
        if cols["id"] >= 0 and cols["id"] < len(row) and row[cols["id"]].strip():
            try:
                task_id = int(row[cols["id"]])
            except ValueError:
                pass

        start = None
        if cols["start"] >= 0 and cols["start"] < len(row) and row[cols["start"]].strip():
            start = parse_date_str(row[cols["start"]].strip())

        finish = None
        if cols["finish"] >= 0 and cols["finish"] < len(row) and row[cols["finish"]].strip():
            finish = parse_date_str(row[cols["finish"]].strip())

        outline_level = 1
        if (
            cols["outline_level"] >= 0
            and cols["outline_level"] < len(row)
            and row[cols["outline_level"]].strip()
        ):
            try:
                outline_level = int(row[cols["outline_level"]])
            except ValueError:
                pass

        # Parse predecessors
        predecessors = []
        if (
            cols["predecessors"] >= 0
            and cols["predecessors"] < len(row)
            and row[cols["predecessors"]].strip()
        ):
            pred_str = row[cols["predecessors"]].strip()
            for part in re.split(r"[;,]", pred_str):
                match = re.match(r"(\d+)\s*(FS|FF|SS|SF)?", part.strip(), re.IGNORECASE)
                if match:
                    predecessors.append(
                        {"id": int(match.group(1)), "type": (match.group(2) or "FS").upper()}
                    )

        # Parse percent complete
        percent_complete = 0
        if (
            cols["percent_complete"] >= 0
            and cols["percent_complete"] < len(row)
            and row[cols["percent_complete"]].strip()
        ):
            try:
                percent_complete = int(row[cols["percent_complete"]].strip().rstrip("%"))
            except ValueError:
                pass

        # Parse milestone
        is_milestone = False
        if (
            cols["milestone"] >= 0
            and cols["milestone"] < len(row)
            and row[cols["milestone"]].strip().lower() in ("yes", "true", "1")
        ):
            is_milestone = True

        # Parse notes
        notes = ""
        if cols["notes"] >= 0 and cols["notes"] < len(row):
            notes = row[cols["notes"]].strip()

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
                match = re.search(r"Customer:\s*([^;]+)", task["notes"], re.IGNORECASE)
                if match:
                    project_data["customer"] = match.group(1).strip()
            break

    return project_data


def parse_date_str(date_str) -> date | None:
    """Parse various date formats and return date object."""
    if not date_str:
        return None

    # If already a Python date object
    if isinstance(date_str, date):
        return date_str

    # If it's a datetime, extract date
    if isinstance(date_str, datetime):
        return date_str.date()

    # Handle Java LocalDate/LocalDateTime objects (from JPype)
    # These have methods like getYear(), getMonthValue(), getDayOfMonth()
    if (
        hasattr(date_str, "getYear")
        and hasattr(date_str, "getMonthValue")
        and hasattr(date_str, "getDayOfMonth")
    ):
        try:
            return date(
                int(date_str.getYear()),
                int(date_str.getMonthValue()),
                int(date_str.getDayOfMonth()),
            )
        except Exception:
            pass

    # Handle Java Date objects (legacy)
    if hasattr(date_str, "toInstant"):
        try:
            # Convert Java Date to string and parse
            date_str = str(date_str)
        except Exception:
            pass

    # Convert to string if not already
    if not isinstance(date_str, str):
        date_str = str(date_str)

    # Handle empty strings
    if not date_str or date_str.lower() in ("none", "null", ""):
        return None

    # Try ISO format first
    try:
        return datetime.fromisoformat(date_str.replace("Z", "+00:00")).date()
    except (ValueError, AttributeError):
        pass

    # Try common formats
    formats = [
        "%Y-%m-%dT%H:%M:%S",  # ISO without timezone
        "%Y-%m-%dT%H:%M",  # ISO short
        "%Y-%m-%d",  # ISO date only
        "%m/%d/%Y",
        "%d/%m/%Y",
        "%m/%d/%y",
        "%d/%m/%y",
        "%B %d, %Y",
        "%b %d, %Y",
    ]

    for fmt in formats:
        try:
            return datetime.strptime(date_str, fmt).date()
        except ValueError:
            continue

    # Last resort: try dateutil parser
    try:
        from dateutil import parser

        return parser.parse(date_str).date()
    except Exception:
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

        # Check if everything is working
        modules = result.get("modules", {})
        all_ok = (
            "ERROR" not in str(modules.get("jpype", ""))
            and "ERROR" not in str(modules.get("jvm", ""))
            and "ERROR" not in str(modules.get("mpxj", ""))
        )

        return {
            "success": all_ok,
            "ready": all_ok,
            "message": "MPP import is ready"
            if all_ok
            else "MPP import not available - see details below",
            **result,
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"MPP availability check failed: {e}")
        return JSONResponse(
            status_code=500,
            content={
                "success": False,
                "ready": False,
                "error": "Internal error checking MPP import availability",
                "setup_instructions": get_jvm_setup_instructions(),
            },
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

    if not file.filename.lower().endswith((".mpp", ".mpt", ".mpx", ".xml")):
        raise HTTPException(
            status_code=400, detail="Invalid file type. Supported: .mpp, .mpt, .mpx, .xml"
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
        logger.error(f"MPP import failed: {e}")
        return JSONResponse(status_code=500, content={"success": False, "error": "Failed to parse MPP file"})
    finally:
        # Clean up temp file
        if temp_file and os.path.exists(temp_file.name):
            try:
                os.unlink(temp_file.name)
            except Exception:
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
    parsed_site_id: int | None = None
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
        if filename_lower.endswith(".csv"):
            # Parse CSV directly
            text_content = content.decode("utf-8-sig")  # Handle BOM
            project_data = parse_csv_file(text_content)
        elif filename_lower.endswith((".mpp", ".mpt", ".mpx", ".xml")):
            # Save to temp file for MPXJ
            suffix = os.path.splitext(file.filename)[1]
            temp_file = tempfile.NamedTemporaryFile(delete=False, suffix=suffix)
            temp_file.write(content)
            temp_file.close()

            project_data = parse_mpp_file(temp_file.name)
        else:
            raise HTTPException(
                status_code=400, detail="Invalid file type. Supported: .csv, .mpp, .mpt, .mpx, .xml"
            )

        # Create project
        project = Project(
            name=project_data.get("name", "Imported Project"),
            site_id=parsed_site_id,
            customer=project_data.get("customer"),
            start_date=parse_date_str(project_data.get("start_date"))
            if project_data.get("start_date")
            else date.today(),
            end_date=parse_date_str(project_data.get("finish_date"))
            if project_data.get("finish_date")
            else date.today(),
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
        async def create_subphases_for_parent(
            parent_id: int, parent_type: str, parent_csv_id: int, depth: int = 1
        ):
            nonlocal subphases_created

            # Find children of this parent
            children = [
                t
                for t in work_tasks
                if t.get("parent_id") == parent_csv_id and t.get("outline_level", 1) > 2
            ]

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
                    await create_subphases_for_parent(phase_info["db_id"], "phase", task["id"])

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
                    deps.append({"id": pred_info["db_id"], "type": pred.get("type", "FS")})

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

        logger.error(f"Import failed: {str(e)}")
        logger.error(traceback.format_exc())
        await db.rollback()

        error_msg = str(e)
        error_detail: dict[str, Any] = {"success": False, "error": "Project import failed"}

        # Check if this is a JVM/Java error
        if (
            "libjvm" in error_msg
            or "JVMNotFoundException" in str(type(e).__name__)
            or "JAVA_HOME" in error_msg
        ):
            error_detail["java_error"] = True
            error_detail["setup_instructions"] = get_jvm_setup_instructions()
            error_detail["error"] = "Java/JVM not found. MPP import requires Java to be installed."

        return JSONResponse(status_code=500, content=error_detail)
    finally:
        # Clean up temp file
        if temp_file and os.path.exists(temp_file.name):
            try:
                os.unlink(temp_file.name)
            except Exception:
                pass
