# What-If Planning

**What-If Mode** lets administrators and superusers experiment with scheduling changes without affecting the live data.

## How It Works

1. Click the **What-If** toggle in the header
2. The interface changes visually to remind you that you're in planning mode
3. Make any changes: move phases, reassign staff, adjust dates, etc.
4. Changes are **not saved to the database** — they exist only in your session
5. When done, choose:
   - **Commit changes** — Apply all What-If modifications to the live database
   - **Discard changes** — Reload original data, discarding all modifications

## Key Behaviors

- What-If changes are broadcast in real-time to other connected users via WebSocket, so collaborators can see your experimental planning
- Changes are not persisted until explicitly committed
- Only administrators and superusers can enter What-If mode

## Use Cases

- Test resource reallocation before committing
- Explore "what happens if we move Project X to Q3?"
- Plan team changes without disrupting the live schedule
- Present planning options to stakeholders before deciding
