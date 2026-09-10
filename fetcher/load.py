from __future__ import annotations

from datetime import date, datetime, timezone
from dataclasses import dataclass
from pathlib import Path

import psycopg
from psycopg.types.json import Json

from fetcher.parse import EventRow, warehouse_properties

MIGRATION_PATH = Path(__file__).resolve().parent.parent / "supabase" / "migrations" / "001_events.sql"
MAX_IDENTITY_MISMATCHES = 10


@dataclass(frozen=True)
class UpsertStats:
    inserted: int
    identity_mismatches: int


class IdentityMismatchError(RuntimeError):
    """The incoming export disagrees with existing event identity columns."""

    def __init__(self, count: int) -> None:
        self.count = count
        super().__init__(
            f"{count} event identity mismatches; refusing to write the batch"
        )


def apply_migration(conn: psycopg.Connection, sql_path: Path | None = None) -> None:
    path = sql_path or MIGRATION_PATH
    exists = conn.execute("select to_regclass('public.events')").fetchone()[0]
    if exists:
        return
    conn.execute(path.read_text())


def reset_tables(conn: psycopg.Connection) -> None:
    conn.execute("truncate table events, export_watermarks")


def _unique_rows(rows: list[EventRow]) -> list[EventRow]:
    unique: list[EventRow] = []
    seen: set[str] = set()
    for row in rows:
        if row.insert_id in seen:
            continue
        seen.add(row.insert_id)
        unique.append(row)
    return unique


def _identity_mismatch_ids(
    conn: psycopg.Connection, rows: list[EventRow]
) -> set[str]:
    if not rows:
        return set()
    result = conn.execute(
        """
        select existing.insert_id
        from events as existing
        join unnest(
            %(insert_id)s::text[],
            %(event_name)s::text[],
            %(event_time)s::timestamptz[],
            %(distinct_id)s::text[],
            %(company_id)s::text[]
        ) as incoming(
            insert_id, event_name, event_time, distinct_id, company_id
        ) on incoming.insert_id = existing.insert_id
        where existing.event_name is distinct from incoming.event_name
           or existing.event_time is distinct from incoming.event_time
           or existing.distinct_id is distinct from incoming.distinct_id
           or existing.company_id is distinct from incoming.company_id
        """,
        {
            "insert_id": [row.insert_id for row in rows],
            "event_name": [row.event_name for row in rows],
            "event_time": [row.event_time for row in rows],
            "distinct_id": [row.distinct_id for row in rows],
            "company_id": [row.company_id for row in rows],
        },
    )
    return {row[0] for row in result.fetchall()}


def upsert_events_with_stats(
    conn: psycopg.Connection, rows: list[EventRow]
) -> UpsertStats:
    if not rows:
        return UpsertStats(inserted=0, identity_mismatches=0)
    unique = _unique_rows(rows)
    mismatch_ids = _identity_mismatch_ids(conn, unique)
    if len(mismatch_ids) > MAX_IDENTITY_MISMATCHES:
        raise IdentityMismatchError(len(mismatch_ids))
    eligible = [row for row in unique if row.insert_id not in mismatch_ids]
    if not eligible:
        return UpsertStats(inserted=0, identity_mismatches=len(mismatch_ids))

    before = conn.execute("select count(*) from events").fetchone()[0]
    conn.execute(
        """
        insert into events as existing (
            insert_id, event_name, event_time, distinct_id, user_id,
            uc_uuid, email, company_id, company, properties
        )
        select *
        from unnest(
            %(insert_id)s::text[],
            %(event_name)s::text[],
            %(event_time)s::timestamptz[],
            %(distinct_id)s::text[],
            %(user_id)s::text[],
            %(uc_uuid)s::text[],
            %(email)s::text[],
            %(company_id)s::text[],
            %(company)s::text[],
            %(properties)s::jsonb[]
        )
        on conflict (insert_id) do update
        set properties = (
            existing.properties
            || case
                 when nullif(excluded.properties->>'companyName', '') is null
                   then excluded.properties - 'companyName'
                 else excluded.properties
               end
        )
        where existing.event_name is not distinct from excluded.event_name
          and existing.event_time is not distinct from excluded.event_time
          and existing.distinct_id is not distinct from excluded.distinct_id
          and existing.company_id is not distinct from excluded.company_id
          and (
              existing.properties
              || case
                   when nullif(excluded.properties->>'companyName', '') is null
                     then excluded.properties - 'companyName'
                   else excluded.properties
                 end
          ) is distinct from existing.properties
        """,
        {
            "insert_id": [row.insert_id for row in eligible],
            "event_name": [row.event_name for row in eligible],
            "event_time": [row.event_time for row in eligible],
            "distinct_id": [row.distinct_id for row in eligible],
            "user_id": [row.user_id for row in eligible],
            "uc_uuid": [row.uc_uuid for row in eligible],
            "email": [row.email for row in eligible],
            "company_id": [row.company_id for row in eligible],
            "company": [row.company for row in eligible],
            "properties": [
                Json(warehouse_properties(row.properties, row.event_name))
                for row in eligible
            ],
        },
    )
    after = conn.execute("select count(*) from events").fetchone()[0]
    return UpsertStats(
        inserted=after - before,
        identity_mismatches=len(mismatch_ids),
    )


def upsert_events(conn: psycopg.Connection, rows: list[EventRow]) -> int:
    """Upsert events, preserving the historical inserted-count return value."""
    return upsert_events_with_stats(conn, rows).inserted


def get_watermark(conn: psycopg.Connection, job_name: str) -> date | None:
    row = conn.execute(
        "select last_success_date from export_watermarks where job_name = %s",
        (job_name,),
    ).fetchone()
    if not row:
        return None
    return row[0]


def set_watermark(
    conn: psycopg.Connection,
    job_name: str,
    last_success_date: date | None,
    status: str,
    detail: str | None = None,
) -> None:
    conn.execute(
        """
        insert into export_watermarks (
            job_name, last_success_date, last_success_at, status, detail
        ) values (
            %(job_name)s, %(last_success_date)s, %(last_success_at)s, %(status)s, %(detail)s
        )
        on conflict (job_name) do update set
            last_success_date = excluded.last_success_date,
            last_success_at = excluded.last_success_at,
            status = excluded.status,
            detail = excluded.detail
        """,
        {
            "job_name": job_name,
            "last_success_date": last_success_date,
            "last_success_at": datetime.now(timezone.utc),
            "status": status,
            "detail": detail,
        },
    )
