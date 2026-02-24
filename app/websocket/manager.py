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

# Enable debug logging for websocket
logging.getLogger(__name__).setLevel(logging.DEBUG)


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
        print("[WS Manager] Initialized")

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
        print(
            f"[WS Manager] Connection accepted for user {user_id} ({first_name} {last_name}) in tenant '{tenant_id}'"
        )

        # Immediately send a test message to verify connection is alive
        try:
            await websocket.send_text('{"type":"ping","test":"immediate"}')
            print(f"[WS Manager] Immediate ping sent successfully to user {user_id}")
        except Exception as e:
            print(f"[WS Manager] ERROR: Immediate ping failed for user {user_id}: {e}")
            return

        old_websocket_to_close = None

        # Use lock only for modifying the connections dict - keep it short!
        async with self._lock:
            print(f"[WS Manager] Lock acquired for user {user_id}")

            if tenant_id not in self._connections:
                self._connections[tenant_id] = {}

            # Check for existing connection (will close AFTER releasing lock)
            if user_id in self._connections[tenant_id]:
                old_conn = self._connections[tenant_id][user_id]
                old_websocket_to_close = old_conn.websocket
                print(f"[WS Manager] Will close existing connection for user {user_id}")

            # Store new connection
            connected_user = ConnectedUser(
                user_id=user_id,
                first_name=first_name,
                last_name=last_name,
                websocket=websocket,
            )
            self._connections[tenant_id][user_id] = connected_user

            print(
                f"[WS Manager] Total connections in tenant '{tenant_id}': {len(self._connections[tenant_id])}"
            )
            print(f"[WS Manager] Connected users: {list(self._connections[tenant_id].keys())}")

        print(f"[WS Manager] Lock released for user {user_id}")

        # Note: We used to close old connections here, but that can cause issues
        # with the close() call interfering with the new connection.
        # Old connections will time out naturally or be garbage collected.
        if old_websocket_to_close:
            print(f"[WS Manager] Old connection exists for user {user_id} - will timeout naturally")

        print(f"[WS Manager] About to send presence list to user {user_id}")
        logger.info(f"WebSocket connected: user={user_id} tenant={tenant_id}")

        # Check if connection is still open before sending
        if websocket.client_state.name != "CONNECTED":
            print(
                f"[WS Manager] WARNING: WebSocket not connected! State: {websocket.client_state.name}"
            )
            await self.disconnect(tenant_id, user_id)
            return

        print(f"[WS Manager] WebSocket state: {websocket.client_state.name}")

        # Send current online users to the new connection (with safety check)
        try:
            print("[WS Manager] Calling _send_presence_list...")
            await self._send_presence_list(websocket, tenant_id)
            print("[WS Manager] Presence list sent successfully")
        except Exception as e:
            print(f"[WS Manager] Failed to send presence list: {e}")
            import traceback

            traceback.print_exc()
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
                print(f"[WS Manager] Disconnected user {user_id} from tenant '{tenant_id}'")
                print(
                    f"[WS Manager] Remaining connections in tenant '{tenant_id}': {len(self._connections.get(tenant_id, {}))}"
                )

                # Clean up empty tenant rooms
                if not self._connections[tenant_id]:
                    del self._connections[tenant_id]

        logger.info(f"WebSocket disconnected: user={user_id} tenant={tenant_id}")

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

        print(f"[WS Manager] Sending presence list with {len(users)} users")
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
        print(
            f"[WS Manager] Broadcasting {message.get('type')} to tenant '{tenant_id}', recipients: {recipients} (excluding: {exclude_user})"
        )

        for user_id, connected_user in connections.items():
            if exclude_user and user_id == exclude_user:
                continue

            try:
                await self._send_json(connected_user.websocket, message)
                print(f"[WS Manager] Sent to user {user_id}")
            except Exception as e:
                print(f"[WS Manager] Failed to send to user {user_id}: {e}")
                logger.warning(f"Failed to send to user {user_id}: {e}")
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
        print(
            f"[WS Manager] broadcast_change called: {entity_type}:{action} by user {user_id} ({user_name}) in tenant '{tenant_id}'"
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
                print(
                    f"[WS Manager] Cannot send - WebSocket not connected (state: {websocket.client_state.name})"
                )
                return
            await websocket.send_text(json.dumps(data))
        except RuntimeError as e:
            # Handle "Cannot call send once close message has been sent"
            print(f"[WS Manager] WebSocket already closed: {e}")
        except Exception as e:
            print(f"[WS Manager] Error sending to WebSocket: {e}")

    def get_online_count(self, tenant_id: str) -> int:
        """Get number of online users in a tenant."""
        count = len(self._connections.get(tenant_id, {}))
        print(f"[WS Manager] get_online_count('{tenant_id}'): {count}")
        return count

    def get_online_users(self, tenant_id: str) -> list[dict]:
        """Get list of online users in a tenant."""
        if tenant_id not in self._connections:
            return []
        return [user.to_presence_dict() for user in self._connections[tenant_id].values()]


# Global connection manager instance
manager = ConnectionManager()
