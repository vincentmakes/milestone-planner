"""
WebSocket Connection Manager

Manages WebSocket connections with:
- Tenant-based isolation (users only see activity in their tenant)
- Multiple concurrent connections per user (multiple tabs/devices supported)
- Session-based authentication
- Presence tracking (who's online)
- Broadcast of changes to connected clients
"""

import asyncio
import itertools
import json
import logging
from dataclasses import dataclass, field
from datetime import datetime

from fastapi import WebSocket

from app.utils import utcnow_naive

logger = logging.getLogger(__name__)


@dataclass
class ConnectedUser:
    """Represents a single WebSocket connection for a user.

    A user may have multiple ConnectedUser entries simultaneously (one per
    tab/device). Each is keyed by a unique connection_id so that closing one
    tab doesn't drop messages destined for another.
    """

    connection_id: int
    user_id: int
    first_name: str
    last_name: str
    websocket: WebSocket
    connected_at: datetime = field(default_factory=utcnow_naive)
    # Session the socket authenticated with, so revoking "every session but
    # this one" can keep the caller's own tab connected.
    session_id: str | None = None

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
    and receive broadcasts from the same tenant. Each user can have
    multiple concurrent connections (different tabs/devices); broadcasts
    fan out to every active connection.
    """

    def __init__(self):
        # tenant_id -> connection_id -> ConnectedUser
        self._connections: dict[str, dict[int, ConnectedUser]] = {}
        self._lock = asyncio.Lock()
        self._connection_id_counter = itertools.count(1)
        logger.info("WebSocket Manager initialized")

    def _next_connection_id(self) -> int:
        return next(self._connection_id_counter)

    def _user_has_other_connections(
        self, tenant_id: str, user_id: int, exclude_conn_id: int
    ) -> bool:
        connections = self._connections.get(tenant_id, {})
        for cid, conn in connections.items():
            if cid != exclude_conn_id and conn.user_id == user_id:
                return True
        return False

    async def connect(
        self,
        websocket: WebSocket,
        tenant_id: str,
        user_id: int,
        first_name: str,
        last_name: str,
        session_id: str | None = None,
    ) -> int:
        """
        Accept a new WebSocket connection.

        Returns the connection_id, which the caller passes back to disconnect()
        so we tear down the right connection if the user has multiple tabs open.
        """
        await websocket.accept()
        connection_id = self._next_connection_id()
        logger.info(
            "Connection accepted: conn=%s user=%s (%s %s) tenant='%s'",
            connection_id,
            user_id,
            first_name,
            last_name,
            tenant_id,
        )

        connected_user = ConnectedUser(
            connection_id=connection_id,
            user_id=user_id,
            first_name=first_name,
            last_name=last_name,
            websocket=websocket,
            session_id=session_id,
        )

        async with self._lock:
            if tenant_id not in self._connections:
                self._connections[tenant_id] = {}
            self._connections[tenant_id][connection_id] = connected_user
            total = len(self._connections[tenant_id])

        logger.info(
            "WebSocket registered: conn=%s user=%s tenant=%s (total connections in tenant: %d)",
            connection_id,
            user_id,
            tenant_id,
            total,
        )

        if websocket.client_state.name != "CONNECTED":
            logger.warning("WebSocket not connected! State: %s", websocket.client_state.name)
            await self.disconnect(tenant_id, connection_id)
            return connection_id

        # Send current online users to the new connection
        try:
            await self._send_presence_list(websocket, tenant_id)
        except Exception as e:
            logger.exception("Failed to send presence list: %s", e)
            await self.disconnect(tenant_id, connection_id)
            return connection_id

        # Broadcast join event to others (only meaningful when this is the
        # user's first connection in the tenant; otherwise other clients
        # already know about them).
        is_first_connection_for_user = not self._user_has_other_connections(
            tenant_id, user_id, exclude_conn_id=connection_id
        )
        if is_first_connection_for_user:
            await self.broadcast_to_tenant(
                tenant_id,
                {
                    "type": "presence:join",
                    "payload": connected_user.to_presence_dict(),
                    "timestamp": utcnow_naive().isoformat() + "Z",
                },
                exclude_connection=connection_id,
            )

        return connection_id

    async def disconnect(self, tenant_id: str, connection_id: int) -> None:
        """Handle WebSocket disconnection for a single connection."""
        user_id: int | None = None
        last_for_user = False
        async with self._lock:
            tenant_conns = self._connections.get(tenant_id)
            if tenant_conns:
                conn = tenant_conns.pop(connection_id, None)
                if conn:
                    user_id = conn.user_id
                    # Did the user have any other connections after removal?
                    last_for_user = not any(c.user_id == user_id for c in tenant_conns.values())
                if not tenant_conns:
                    del self._connections[tenant_id]

        logger.info(
            "WebSocket disconnected: conn=%s user=%s tenant=%s last_for_user=%s",
            connection_id,
            user_id,
            tenant_id,
            last_for_user,
        )

        # Only emit presence:leave when the user has no remaining tabs/devices
        if user_id is not None and last_for_user:
            await self.broadcast_to_tenant(
                tenant_id,
                {
                    "type": "presence:leave",
                    "payload": {"user_id": user_id},
                    "timestamp": utcnow_naive().isoformat() + "Z",
                },
            )

    async def disconnect_user(
        self,
        tenant_id: str,
        user_id: int,
        *,
        except_session_id: str | None = None,
        code: int = 4001,
        reason: str = "Session revoked",
    ) -> int:
        """
        Close every connection of ``user_id`` in a tenant (session revocation).

        Connections opened with ``except_session_id`` are kept. Close code 4001
        makes the client drop to the login screen without reconnecting. Per
        process and best effort: a socket on another worker is not reached,
        and a close that fails is ignored. Returns the number of connections
        removed.
        """
        async with self._lock:
            tenant_conns = self._connections.get(tenant_id, {})
            doomed = [
                conn
                for conn in tenant_conns.values()
                if conn.user_id == user_id
                and (except_session_id is None or conn.session_id != except_session_id)
            ]
            for conn in doomed:
                tenant_conns.pop(conn.connection_id, None)
            still_online = any(c.user_id == user_id for c in tenant_conns.values())
            if not tenant_conns and tenant_id in self._connections:
                del self._connections[tenant_id]

        for conn in doomed:
            try:
                await conn.websocket.close(code=code, reason=reason)
            except Exception as e:
                logger.debug("Close of revoked conn=%s failed: %s", conn.connection_id, e)

        if doomed:
            logger.info(
                "Closed %d WebSocket(s) of user %s in tenant '%s' (%s)",
                len(doomed),
                user_id,
                tenant_id,
                reason,
            )
            if not still_online:
                await self.broadcast_to_tenant(
                    tenant_id,
                    {
                        "type": "presence:leave",
                        "payload": {"user_id": user_id},
                        "timestamp": utcnow_naive().isoformat() + "Z",
                    },
                )
        return len(doomed)

    async def _send_presence_list(self, websocket: WebSocket, tenant_id: str) -> None:
        """Send list of currently online users (deduplicated by user_id) to a connection."""
        seen: set[int] = set()
        users: list[dict] = []
        async with self._lock:
            for conn in self._connections.get(tenant_id, {}).values():
                if conn.user_id in seen:
                    continue
                seen.add(conn.user_id)
                users.append(conn.to_presence_dict())

        await self._send_json(
            websocket,
            {
                "type": "presence:list",
                "payload": {"users": users},
                "timestamp": utcnow_naive().isoformat() + "Z",
            },
        )

    async def broadcast_to_tenant(
        self,
        tenant_id: str,
        message: dict,
        exclude_user: int | None = None,
        exclude_connection: int | None = None,
    ) -> int:
        """
        Broadcast a message to all connections in a tenant.

        Args:
            tenant_id: Target tenant
            message: Message dict to send
            exclude_user: Optional user ID to exclude (e.g., the sender). All
                connections belonging to that user are skipped.
            exclude_connection: Optional connection_id to exclude (e.g. the
                originating tab when broadcasting presence:join from connect).

        Returns the number of connections the message was sent to.
        """
        if not self._encodable(tenant_id, message):
            return 0
        async with self._lock:
            connections = list(self._connections.get(tenant_id, {}).values())

        sent = 0
        failed: list[int] = []
        for conn in connections:
            if exclude_user is not None and conn.user_id == exclude_user:
                continue
            if exclude_connection is not None and conn.connection_id == exclude_connection:
                continue
            if await self._try_send(conn, message):
                sent += 1
            else:
                failed.append(conn.connection_id)

        logger.info(
            "Broadcast %s to tenant '%s': %d/%d recipients (exclude_user=%s)",
            message.get("type"),
            tenant_id,
            sent,
            len(connections),
            exclude_user,
        )
        await self._prune(tenant_id, failed)
        return sent

    async def send_to_user(self, tenant_id: str, user_id: int, message: dict) -> int:
        """
        Send a message to every connection belonging to ONE user in a tenant.

        The counterpart to broadcast_to_tenant, which can only exclude users.
        Multi-tab is handled by construction: each of the user's connections
        gets the message.

        Returns the number of connections reached. Zero means the user is not
        connected *to this process* -- the manager is per-process and in-memory,
        so with more than one worker a user on another process is not reached.
        Callers must therefore persist the payload first and treat this push as
        a live hint, not as delivery.
        """
        if not self._encodable(tenant_id, message):
            return 0
        async with self._lock:
            connections = [
                conn
                for conn in self._connections.get(tenant_id, {}).values()
                if conn.user_id == user_id
            ]

        sent = 0
        failed: list[int] = []
        for conn in connections:
            if await self._try_send(conn, message):
                sent += 1
            else:
                failed.append(conn.connection_id)

        logger.info(
            "Sent %s to user %s in tenant '%s': %d connection(s)",
            message.get("type"),
            user_id,
            tenant_id,
            sent,
        )
        await self._prune(tenant_id, failed)
        return sent

    def _encodable(self, tenant_id: str, message: dict) -> bool:
        """
        Check once per fan-out that ``message`` is JSON-serializable.

        A payload the router built wrongly (a ``date``, a ``Decimal``, an ORM
        object) would otherwise fail in ``_send_json`` for every recipient and
        get every connection of the tenant pruned as "dead".
        """
        try:
            json.dumps(message)
            return True
        except (TypeError, ValueError):
            logger.exception(
                "Dropping unserializable %s message for tenant '%s'",
                message.get("type"),
                tenant_id,
            )
            return False

    async def _try_send(self, conn: ConnectedUser, message: dict) -> bool:
        """``_send_json`` for a fan-out: any failure counts as not sent."""
        try:
            return await self._send_json(conn.websocket, message)
        except Exception as e:
            logger.warning(
                "Failed to send to conn=%s user=%s: %s", conn.connection_id, conn.user_id, e
            )
            return False

    async def _prune(self, tenant_id: str, connection_ids: list[int]) -> None:
        """
        Unregister connections a send just failed on (closed or broken sockets).

        Runs after the fan-out, never while iterating the registry. Ids already
        gone are skipped; ``disconnect`` may broadcast ``presence:leave``, which
        can prune further dead sockets - bounded, as each step removes one.
        """
        for connection_id in connection_ids:
            if connection_id in self._connections.get(tenant_id, {}):
                logger.info("Pruning dead WebSocket conn=%s tenant=%s", connection_id, tenant_id)
                await self.disconnect(tenant_id, connection_id)

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
        Broadcast a change event to all OTHER users in a tenant. The
        originating user is excluded across all of their tabs/devices.
        """
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
                "timestamp": utcnow_naive().isoformat() + "Z",
            },
            exclude_user=user_id,
        )

    async def _send_json(self, websocket: WebSocket, data: dict) -> bool:
        """Send JSON data through WebSocket; never raises, returns whether it was sent."""
        try:
            if websocket.client_state.name != "CONNECTED":
                logger.debug(
                    "Cannot send - WebSocket not connected (state: %s)",
                    websocket.client_state.name,
                )
                return False
            await websocket.send_text(json.dumps(data))
            return True
        except RuntimeError as e:
            # Handle "Cannot call send once close message has been sent"
            logger.debug("WebSocket already closed: %s", e)
        except Exception as e:
            logger.warning("Error sending to WebSocket: %s", e)
        return False

    def get_online_count(self, tenant_id: str) -> int:
        """Get number of distinct online users in a tenant."""
        connections = self._connections.get(tenant_id, {})
        return len({c.user_id for c in connections.values()})

    def get_online_users(self, tenant_id: str) -> list[dict]:
        """Get list of online users (deduplicated) in a tenant."""
        seen: set[int] = set()
        out: list[dict] = []
        for conn in self._connections.get(tenant_id, {}).values():
            if conn.user_id in seen:
                continue
            seen.add(conn.user_id)
            out.append(conn.to_presence_dict())
        return out


# Global connection manager instance
manager = ConnectionManager()
