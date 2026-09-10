"""FastAPI application entry point."""

import asyncio
import logging
import sys
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

# Fix for Windows: Use ProactorEventLoop for subprocess support (Playwright)
if sys.platform == "win32":
    asyncio.set_event_loop_policy(asyncio.WindowsProactorEventLoopPolicy())

logger = logging.getLogger(__name__)
from fastapi.middleware.cors import CORSMiddleware

from app import __version__
from app.ai_budget import operation_error_content
from app.auth import HostingAuthMiddleware, get_auth_store
from app.auth import router as auth_router
from app.config import settings
from app.database import DatabaseBusyError, db
from app.hosting import get_hosting_settings, validate_hosting_settings
from app.pdf import close_pdf_renderer
from app.routers import (
    applications_router,
    career_router,
    config_router,
    enrichment_router,
    health_router,
    jobs_router,
    resume_wizard_router,
    resumes_router,
)
from app.routers.billing import router as billing_router
from app.routers.account import router as account_router
from app.routers.recruitment import router as recruitment_router
from app.routers.resume_exports import router as resume_exports_router
from app.routers.resumes import drain_processing_cleanup_tasks


def _configure_application_logging() -> None:
    """Set application log level from configuration."""
    numeric_level = getattr(logging, settings.log_level, logging.INFO)
    logging.getLogger("app").setLevel(numeric_level)


_configure_application_logging()


async def _recover_credit_reservations() -> None:
    from app.credits import recover_expired_operations

    while True:
        await asyncio.sleep(60)
        try:
            await asyncio.to_thread(recover_expired_operations)
        except Exception:
            logger.warning("Credit reservation recovery deferred until next check")


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    """Application lifespan manager."""
    # Startup
    validate_hosting_settings()
    settings.data_dir.mkdir(parents=True, exist_ok=True)
    # Import a legacy TinyDB database into SQLite if present (idempotent).
    # Fail-fast on error: starting with an empty DB would look like data loss.
    from app.scripts.migrate_tinydb_to_sqlite import migrate as migrate_tinydb

    if get_hosting_settings().hosted:
        from app.migrations import migrate, migrate_existing_workspaces
        from app.credits import recover_expired_operations

        await asyncio.to_thread(get_auth_store().initialize)
        await asyncio.to_thread(migrate, settings.sqlite_path, "business")
        await asyncio.to_thread(migrate_existing_workspaces, settings.data_dir)
        await asyncio.to_thread(recover_expired_operations)
    else:
        result = await migrate_tinydb()
        if result.get("status") == "migrated":
            logger.info("Startup data migration: %s", result)
    # Fold any legacy plaintext API keys into the encrypted store (idempotent,
    # non-clobbering), then strip them from config.json.
    from app.config import migrate_legacy_keys

    migrate_legacy_keys()
    # PDF renderer uses lazy initialization - will initialize on first use
    # await init_pdf_renderer()
    recovery = (
        asyncio.create_task(_recover_credit_reservations())
        if get_hosting_settings().hosted else None
    )
    try:
        yield
    finally:
        if recovery is not None:
            recovery.cancel()
            await asyncio.gather(recovery, return_exceptions=True)
    # Shutdown - wrap each cleanup in try-except to ensure all resources are released
    try:
        await drain_processing_cleanup_tasks()
    except Exception:
        logger.exception("Error draining processing cleanup")

    try:
        await close_pdf_renderer()
    except Exception:
        logger.exception("Error closing PDF renderer")

    try:
        await db.close()
    except Exception:
        logger.exception("Error closing database")


app = FastAPI(
    title="CareerLens API",
    description="Evidence-based resume diagnosis and job matching",
    version=__version__,
    lifespan=lifespan,
)


@app.exception_handler(DatabaseBusyError)
async def database_busy_handler(
    request: Request, error: DatabaseBusyError
) -> JSONResponse:
    logger.warning("Database write contention for %s", request.url.path, exc_info=error)
    return JSONResponse(
        status_code=503,
        content=operation_error_content(
            request, "Database is busy. Please retry shortly."
        ),
        headers={"Retry-After": "1"},
    )


# CORS middleware - origins configurable via CORS_ORIGINS env var
app.add_middleware(
    CORSMiddleware,
    allow_origins=(
        [get_hosting_settings().public_origin]
        if get_hosting_settings().hosted
        else settings.effective_cors_origins
    ),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.add_middleware(HostingAuthMiddleware)

# Include routers
app.include_router(auth_router, prefix="/api/v1")
app.include_router(account_router, prefix="/api/v1")
app.include_router(billing_router, prefix="/api/v1")
app.include_router(career_router, prefix="/api/v1")
app.include_router(recruitment_router, prefix="/api/v1")
app.include_router(health_router, prefix="/api/v1")
app.include_router(config_router, prefix="/api/v1")
app.include_router(resumes_router, prefix="/api/v1")
app.include_router(resume_exports_router, prefix="/api/v1")
app.include_router(jobs_router, prefix="/api/v1")
app.include_router(enrichment_router, prefix="/api/v1")
app.include_router(applications_router, prefix="/api/v1")
app.include_router(resume_wizard_router, prefix="/api/v1")


@app.get("/")
async def root():
    """Root endpoint."""
    return {
        "name": "CareerLens API",
        "version": __version__,
        "docs": None if get_hosting_settings().hosted else "/docs",
    }


def main():
    """Entry point for the project.scripts console script."""
    import uvicorn

    uvicorn.run(
        "app.main:app",
        host=settings.host,
        port=settings.port,
        reload=settings.reload,
    )


if __name__ == "__main__":
    main()
