"""Rebuild retention + explorer tables from the events warehouse.

Reads ``SUPABASE_DB_URL`` from ``.env`` (via python-dotenv when available,
otherwise a minimal parser), then calls ``public.refresh_retention``
(migration 004). That function idempotently rebuilds, in one transaction::

    client_company      - one row per client company (staff-only excluded)
    company_activation  - one row per client company: first 'Accounting Sync'
    company_week_value  - one row per (client company, IST week with any event)
    retention_cells     - cohort_week x rel_week 0..8 matrix (clients only)
    company_profile     - per activated client company: signup, path dates,
                          lifetime actions, active weeks, path booleans
    company_week_action - per (client company, IST action week): action mix

Signed contract lives in ``supabase/migrations/004_sync_rpcs.sql``.
This module does not write ``public.events``.
"""

from __future__ import annotations

import os
import re
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
MIGRATION_002 = PROJECT_ROOT / "supabase" / "migrations" / "002_retention.sql"
MIGRATION_003 = PROJECT_ROOT / "supabase" / "migrations" / "003_explorer.sql"
MIGRATION_004 = PROJECT_ROOT / "supabase" / "migrations" / "004_sync_rpcs.sql"

SOURCE_TABLE = "public.events"
TIMEZONE = "Asia/Kolkata"

# Canonical action lists. SQL in 004_sync_rpcs.sql must match these
# literals. metrics.api.ACTION_EVENTS mirrors this tuple.
ACTION_EVENTS = (
    "Upload",
    "Mapping Completed",
    "Saved Template Loaded",
    "Invoice Created",
    "Invoice Bulk Edited",
    "Download-Inv",
    "Preview",
    "Transaction Ledger Updated",
    "Transaction Status",
    "Transaction Type Updated",
    "Transaction Configuration Edited",
    "Vendor Mismatch Resolved",
    "Accounting Sync",
    "Recon Processed",
    "Entity Created",
    "Delete",
    "Download",
    "Export",
)
TXN_EVENTS = (
    "Transaction Ledger Updated",
    "Transaction Status",
    "Transaction Type Updated",
    "Transaction Configuration Edited",
    "Vendor Mismatch Resolved",
)
AP_EVENTS = (
    "Invoice Created",
    "Invoice Bulk Edited",
    "Download-Inv",
    "Preview",
)
OTHER_ACTION_EVENTS = (
    "Mapping Completed",
    "Saved Template Loaded",
    "Entity Created",
    "Delete",
    "Download",
    "Export",
)
READY_EVENTS = ("Invoice Created", "Transaction Ledger Updated")
ALLOWED_SOURCES = frozenset({"public.events", "metrics_scratch.events"})

_TABLE_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$")


def load_env() -> None:
    """Populate os.environ from .env without overriding existing vars."""
    try:
        from dotenv import load_dotenv

        load_dotenv(PROJECT_ROOT / ".env", override=False)
        return
    except ImportError:
        pass
    env_path = PROJECT_ROOT / ".env"
    if not env_path.exists():
        return
    for line in env_path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        if not key or key in os.environ:
            continue
        value = value.strip().strip("'").strip('"')
        os.environ[key] = value


def get_db_url() -> str:
    url = os.environ.get("SUPABASE_DB_URL")
    if not url:
        raise SystemExit("missing env SUPABASE_DB_URL")
    return url


def _derived_tables_exist(conn) -> bool:
    rows = conn.execute(
        """
        SELECT relname
        FROM (VALUES
            ('client_company'),
            ('company_activation'),
            ('company_week_value'),
            ('retention_cells'),
            ('company_profile'),
            ('company_week_action')
        ) AS t(relname)
        WHERE to_regclass('public.' || relname) IS NULL
        """
    ).fetchall()
    return len(rows) == 0


def _refresh_rpc_exists(conn) -> bool:
    row = conn.execute(
        "SELECT to_regprocedure('public.refresh_retention(text)')"
    ).fetchone()
    return row is not None and row[0] is not None


def ensure_tables(conn) -> None:
    """Create derived tables and sync RPCs if missing.

    Warehouse DDL is applied by supabase CLI as postgres. The fetcher
    role cannot CREATE, so skip the migration files when objects
    already exist (same pattern as fetcher.load.apply_migration).
    """
    if not _derived_tables_exist(conn):
        conn.execute(MIGRATION_002.read_text())
        conn.execute(MIGRATION_003.read_text())
    if not _refresh_rpc_exists(conn):
        conn.execute(MIGRATION_004.read_text())


def _check_source(source: str) -> str:
    if not _TABLE_RE.match(source) or source not in ALLOWED_SOURCES:
        raise ValueError(f"refusing unsafe source table name: {source!r}")
    return source


def rebuild(conn, source: str = SOURCE_TABLE) -> tuple[int, int, int, int, int, int]:
    """Truncate and rebuild the six tables from the events table.

    Delegates to ``public.refresh_retention``. Never writes to events.
    Returns (activation companies, week_value rows, cells, client
    companies, profile rows, week_action rows).
    """
    source = _check_source(source)
    with conn.transaction():
        row = conn.execute(
            """
            SELECT n_activation, n_week, n_cells, n_client, n_profile,
                   n_week_action
            FROM public.refresh_retention(%s)
            """,
            (source,),
        ).fetchone()
    if row is None:
        raise RuntimeError("refresh_retention returned no row")
    return (row[0], row[1], row[2], row[3], row[4], row[5])


def main(argv: list[str] | None = None) -> int:
    if (argv or ["refresh"])[0] != "refresh":
        print("usage: python -m metrics refresh", file=sys.stderr)
        return 2
    load_env()
    try:
        import psycopg

        conn = psycopg.connect(get_db_url())
    except Exception as exc:  # noqa: BLE001 - report any connect failure
        print(f"metrics refresh failed: {exc}", file=sys.stderr)
        return 1
    try:
        ensure_tables(conn)
        counts = rebuild(conn)
        n_activation, n_week, n_cells = counts[0], counts[1], counts[2]
        n_client, n_profile, n_week_action = counts[3], counts[4], counts[5]
        # Durability: with autocommit off, the pre-check SELECT in
        # ensure_tables() opens the outer transaction, so rebuild()'s
        # `with conn.transaction()` block nests via SAVEPOINT and does not
        # commit by itself. Commit explicitly or conn.close() rolls back.
        conn.commit()
    except Exception as exc:  # noqa: BLE001 - report any refresh failure
        print(f"metrics refresh failed: {exc}", file=sys.stderr)
        return 1
    finally:
        conn.close()
    print(f"client_company companies={n_client}")
    print(f"company_activation companies={n_activation}")
    print(f"company_profile companies={n_profile}")
    print(f"company_week_value rows={n_week}")
    print(f"company_week_action rows={n_week_action}")
    print(f"retention_cells rows={n_cells}")
    return 0
