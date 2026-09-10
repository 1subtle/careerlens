"""Resolve every database facade access within the authenticated user's context."""

import threading
from collections import OrderedDict
from collections.abc import Callable
from pathlib import Path
from typing import TYPE_CHECKING, Any
from uuid import UUID

from app.config import settings

if TYPE_CHECKING:
    from app.database import Database


class TenantContextError(RuntimeError):
    """Hosted document access has no verified user identity."""


class TenantDatabaseProxy:
    """Keep existing facade, ORM, and SQL call sites behind one tenant boundary.

    Tenant engines use NullPool: closing a session releases its connections.
    Eviction only drops idle registry ownership; a bound method or active session
    retains its database/engine until finished. Never dispose on LRU eviction.
    """

    def __init__(
        self,
        operator: "Database",
        factory: Callable[..., "Database"],
        *,
        max_cached: int = 64,
    ) -> None:
        self._operator = operator
        self._factory = factory
        self._max_cached = max_cached
        self._tenants: OrderedDict[Path, Database] = OrderedDict()
        self._lock = threading.RLock()

    def _database(self) -> "Database":
        from app.hosting import current_user_id, is_hosted

        if not is_hosted():
            return self._operator
        identity = current_user_id.get()
        if identity is None:
            raise TenantContextError("Hosted database access requires authentication")
        try:
            user_id = str(UUID(identity))
        except (ValueError, AttributeError, TypeError):
            raise TenantContextError("Invalid hosted user identity") from None
        path = settings.data_dir / "users" / user_id / "workspace.sqlite"
        with self._lock:
            database = self._tenants.pop(path, None)
            if database is None:
                database = self._factory(path, pooled=False)
            self._tenants[path] = database
            while len(self._tenants) > self._max_cached:
                self._tenants.popitem(last=False)
            return database

    def __getattr__(self, name: str) -> Any:
        return getattr(self._database(), name)

    async def close(self) -> None:
        """Explicit application shutdown, after requests and workers have drained."""
        with self._lock:
            databases = [self._operator, *self._tenants.values()]
            self._tenants.clear()
        for database in databases:
            await database.close()
