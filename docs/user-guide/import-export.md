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

!!! note
    MPP/MPT/MPX file import requires Java to be installed on the server (included in the Docker image). CSV and XML imports work without Java.

## Exporting Projects

To export a project:

1. Open the project edit modal (click Edit or right-click then Edit)
2. At the bottom of the modal, two export buttons are available:
   - **CSV Export** — Compatible with Microsoft Project and spreadsheet tools
   - **XML Export** — Microsoft Project XML format

The exported file includes the project hierarchy (phases, subphases), dates, assignments, and custom column values.
