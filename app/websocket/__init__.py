"""
WebSocket package for real-time collaboration.

Provides:
- Connection management with tenant isolation
- Presence tracking (who's online)
- Change broadcasting (real-time updates)
"""

from app.websocket.handler import router
from app.websocket.manager import ConnectionManager, manager

__all__ = ["manager", "ConnectionManager", "router"]
