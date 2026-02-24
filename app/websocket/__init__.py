"""
WebSocket package for real-time collaboration.

Provides:
- Connection management with tenant isolation
- Presence tracking (who's online)
- Change broadcasting (real-time updates)
"""

from app.websocket.manager import manager, ConnectionManager
from app.websocket.handler import router

__all__ = ["manager", "ConnectionManager", "router"]
