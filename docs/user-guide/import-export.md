# Import & Export

## Importing Projects

Milestone can import project data from external tools:

1. Click **Import** in the project panel header
2. Drag-and-drop or browse to select a file:
   - **CSV** — Comma-separated values with columns for project name, phases, dates
   - **XML** — Microsoft Project XML format (`.xml`)
   - **MPP/MPT/MPX** — Microsoft Project native format (requires Java on the server)
3. Milestone parses the file and shows a preview
4. Click **Import Project** to create the project with all phases and subphases

After import, a summary shows the created project, phase count, and subphase count.

### Supported Formats

| Format | Extension | Requirements | Notes |
|--------|-----------|-------------|-------|
| **CSV** | `.csv` | None | Simple comma-separated values with project name, phase names, start/end dates |
| **XML** | `.xml` | None | Microsoft Project XML format — preserves full hierarchy and metadata |
| **MPP** | `.mpp` | Java (JRE 11+) | Microsoft Project native binary format — richest data preservation |
| **MPT** | `.mpt` | Java (JRE 11+) | Microsoft Project template format |
| **MPX** | `.mpx` | Java (JRE 11+) | Older Microsoft Project exchange format |

!!! note
    MPP/MPT/MPX file import requires Java to be installed on the server (included in the Docker image). CSV and XML imports work without Java.

### What Gets Imported

- **Project name** and metadata (start date, end date)
- **Phase hierarchy** — top-level tasks become phases, nested tasks become subphases (unlimited nesting depth preserved)
- **Dates** — start and end dates for all phases and subphases
- **Task names** — preserved as phase/subphase names

Staff assignments, resource allocations, and custom fields from the source file are not imported — these are configured within Milestone after import.

### Troubleshooting Import Issues

| Problem | Solution |
|---------|----------|
| MPP import fails with "Java not found" | Java (JRE 11+) must be installed on the server. The Docker image includes it, but local development may not. |
| Phases appear flat (no nesting) | The source file may not have task hierarchy. Check the WBS structure in Microsoft Project before exporting. |
| Dates look wrong | Ensure the source file uses date formats that can be parsed (ISO 8601 or standard regional formats). |
| Large file takes too long | Very large project files (hundreds of tasks) may take several seconds to parse. Be patient during the preview step. |

## Exporting Projects

To export a project:

1. Open the project edit modal (click Edit or right-click then Edit)
2. At the bottom of the modal, two export buttons are available:
   - **CSV Export** — Compatible with Microsoft Project and spreadsheet tools
   - **XML Export** — Microsoft Project XML format

The exported file includes the project hierarchy (phases, subphases), dates, assignments, and custom column values.
