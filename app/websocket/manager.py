"""
WebSocket Connection Manager

Manages WebSocket connections with:
- Tenant-based isolation (users only see activity in their tenant)
- Session-based authentication
- Presence tracking (who's online)
- Broadcast of changes to connected clients
"""

import asyncio
import json
import logging
from dataclasses import dataclass, field
from datetime import datetime

from fastapi import WebSocket

logger = logging.getLogger(__name__)


@dataclass
class ConnectedUser:
    """Represents a connected WebSocket user."""

    user_id: int
    first_name: str
    last_name: str
    websocket: WebSocket
    connected_at: datetime = field(default_factory=datetime.utcnow)

    def to_presence_dict(self) -> dict:
        """Convert to dict for presence broadcast."""
        return {
            "user_id": self.user_id,
            "first_name": self.first_name,
            "last_name": self.last_name,
            "connected_at": self.connected_at.isoformat() + "Z",
        }


class ConnectionManager:
    """
    Manages WebSocket connections per tenant.

    Each tenant has its own "room" - users can only see other users
    and receive broadcasts from the same tenant.
    """

    def __init__(self):
        # tenant_id -> user_id -> ConnectedUser
        self._connections: dict[str, dict[int, ConnectedUser]] = {}
        # Lock for thread-safe operations
        self._lock = asyncio.Lock()
        logger.info("WebSocket Manager initialized")

    async def connect(
        self,
        websocket: WebSocket,
        tenant_id: str,
        user_id: int,
        first_name: str,
        last_name: str,
    ) -> None:
        """
        Accept a new WebSocket connection.

        Args:
            websocket: The WebSocket connection
            tenant_id: Tenant identifier (or "default" for single-tenant)
            user_id: Authenticated user ID
            first_name: User's first name
            last_name: User's last name
        """
        await websocket.accept()
        logger.info(
            "Connection accepted for user %s (%s %s) in tenant '%s'",
            user_id,
            first_name,
            last_name,
            tenant_id,
        )

        # Immediately send a test message to verify connection is alive
        try:
            await websocket.send_text('{"type":"ping","test":"immediate"}')
            logger.debug("Immediate ping sent successfully to user %s", user_id)
        except Exception as e:
            logger.error("Immediate ping failed for user %s: %s", user_id, e)
            return

        old_websocket_to_close = None

        # Use lock only for modifying the connections dict - keep it short!
        async with self._lock:
            logger.debug("Lock acquired for user %s", user_id)

            if tenant_id not in self._connections:
                self._connections[tenant_id] = {}

            # Check for existing connection (will close AFTER releasing lock)
            if user_id in self._connections[tenant_id]:
                old_conn = self._connections[tenant_id][user_id]
                old_websocket_to_close = old_conn.websocket
                logger.debug("Will close existing connection for user %s", user_id)

            # Store new connection
            connected_user = ConnectedUser(
                user_id=user_id,
                first_name=first_name,
                last_name=last_name,
                websocket=websocket,
            )
            self._connections[tenant_id][user_id] = connected_user

            logger.debug(
                "Total connections in tenant '%s': %d", tenant_id, len(self._connections[tenant_id])
            )
            logger.debug("Connected users: %s", list(self._connections[tenant_id].keys()))

        logger.debug("Lock released for user %s", user_id)

        # Note: We used to close old connections here, but that can cause issues
        # with the close() call interfering with the new connection.
        # Old connections will time out naturally or be garbage collected.
        if old_websocket_to_close:
            logger.debug("Old connection exists for user %s - will timeout naturally", user_id)

        logger.debug("About to send presence list to user %s", user_id)
        logger.info("WebSocket connected: user=%s tenant=%s", user_id, tenant_id)

        # Check if connection is still open before sending
        if websocket.client_state.name != "CONNECTED":
            logger.warning("WebSocket not connected! State: %s", websocket.client_state.name)
            await self.disconnect(tenant_id, user_id)
            return

        logger.debug("WebSocket state: %s", websocket.client_state.name)

        # Send current online users to the new connection (with safety check)
        try:
            logger.debug("Calling _send_presence_list...")
            await self._send_presence_list(websocket, tenant_id)
            logger.debug("Presence list sent successfully")
        except Exception as e:
            logger.exception("Failed to send presence list: %s", e)
            # Connection may have failed, clean up
            await self.disconnect(tenant_id, user_id)
            return

        # Broadcast join event to others
        await self.broadcast_to_tenant(
            tenant_id,
            {
                "type": "presence:join",
                "payload": connected_user.to_presence_dict(),
                "timestamp": datetime.utcnow().isoformat() + "Z",
            },
            exclude_user=user_id,
        )

    async def disconnect(self, tenant_id: str, user_id: int) -> None:
        """
        Handle WebSocket disconnection.
        """
        async with self._lock:
            if tenant_id in self._connections:
                user = self._connections[tenant_id].pop(user_id, None)
                logger.debug("Disconnected user %s from tenant '%s'", user_id, tenant_id)
                logger.debug(
                    "Remaining connections in tenant '%s': %d",
                    tenant_id,
                    len(self._connections.get(tenant_id, {})),
                )

                # Clean up empty tenant rooms
                if not self._connections[tenant_id]:
                    del self._connections[tenant_id]

        logger.info("WebSocket disconnected: user=%s tenant=%s", user_id, tenant_id)

        # Broadcast leave event
        if user:
            await self.broadcast_to_tenant(
                tenant_id,
                {
                    "type": "presence:leave",
                    "payload": {"user_id": user_id},
                    "timestamp": datetime.utcnow().isoformat() + "Z",
                },
            )

    async def _send_presence_list(self, websocket: WebSocket, tenant_id: str) -> None:
        """Send list of currently online users to a connection."""
        users = []
        async with self._lock:
            if tenant_id in self._connections:
                users = [user.to_presence_dict() for user in self._connections[tenant_id].values()]

        logger.debug("Sending presence list with %d users", len(users))
        await self._send_json(
            websocket,
            {
                "type": "presence:list",
                "payload": {"users": users},
                "timestamp": datetime.utcnow().isoformat() + "Z",
            },
        )

    async def broadcast_to_tenant(
        self,
        tenant_id: str,
        message: dict,
        exclude_user: int | None = None,
    ) -> None:
        """
        Broadcast a message to all users in a tenant.

        Args:
            tenant_id: Target tenant
            message: Message dict to send
            exclude_user: Optional user ID to exclude (e.g., the sender)
        """
        async with self._lock:
            connections = self._connections.get(tenant_id, {}).copy()

        recipients = [uid for uid in connections.keys() if uid != exclude_user]
        logger.debug(
            "Broadcasting %s to tenant '%s', recipients: %s (excluding: %s)",
            message.get("type"),
            tenant_id,
            recipients,
            exclude_user,
        )

        for user_id, connected_user in connections.items():
            if exclude_user and user_id == exclude_user:
                continue

            try:
                await self._send_json(connected_user.websocket, message)
                logger.debug("Sent to user %s", user_id)
            except Exception as e:
                logger.warning("Failed to send to user %s: %s", user_id, e)
                # Don't remove here - let the receive loop handle disconnection

    async def broadcast_change(
        self,
        tenant_id: str,
        user_id: int,
        user_name: str,
        entity_type: str,
        entity_id: int,
        project_id: int,
        action: str,
        summary: str | None = None,
    ) -> None:
        """
        Broadcast a change event to all users in a tenant.

        Args:
            tenant_id: Target tenant
            user_id: User who made the change
            user_name: Display name (e.g., "Vincent D.")
            entity_type: Type of entity changed (phase, subphase, project, assignment)
            entity_id: ID of the changed entity
            project_id: Parent project ID
            action: Action type (create, update, delete, move)
            summary: Optional human-readable summary
        """
        logger.debug(
            "broadcast_change called: %s:%s by user %s (%s) in tenant '%s'",
            entity_type,
            action,
            user_id,
            user_name,
            tenant_id,
        )

        await self.broadcast_to_tenant(
            tenant_id,
            {
                "type": f"change:{entity_type}",
                "payload": {
                    "user_id": user_id,
                    "user_name": user_name,
                    "entity_type": entity_type,
                    "entity_id": entity_id,
                    "project_id": project_id,
                    "action": action,
                    "summary": summary,
                },
                "timestamp": datetime.utcnow().isoformat() + "Z",
            },
            exclude_user=user_id,  # Don't send to the user who made the change
        )

    async def _send_json(self, websocket: WebSocket, data: dict) -> None:
        """Send JSON data through WebSocket, with safety check."""
        try:
            # Check if WebSocket is still connected
            if websocket.client_state.name != "CONNECTED":
                logger.debug(
                    "Cannot send - WebSocket not connected (state: %s)", websocket.client_state.name
                )
                return
            await websocket.send_text(json.dumps(data))
        except RuntimeError as e:
            # Handle "Cannot call send once close message has been sent"
            logger.debug("WebSocket already closed: %s", e)
        except Exception as e:
            logger.warning("Error sending to WebSocket: %s", e)

    def get_online_count(self, tenant_id: str) -> int:
        """Get number of online users in a tenant."""
        count = len(self._connections.get(tenant_id, {}))
        logger.debug("get_online_count('%s'): %d", tenant_id, count)
        return count

    def get_online_users(self, tenant_id: str) -> list[dict]:
        """Get list of online users in a tenant."""
        if tenant_id not in self._connections:
            return []
        return [user.to_presence_dict() for user in self._connections[tenant_id].values()]


# Global connection manager instance
manager = ConnectionManager()
