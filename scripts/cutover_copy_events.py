"""Lift-and-shift the public.events warehouse from Free to Pro.

The live cutover uses this box as a bounded-memory pipe:

    Free COPY TO STDOUT -> this process -> Pro COPY FROM STDIN

The script never calls Mixpanel and never copies derived tables. It uses
binary COPY because the first cutover keeps the events schema identical.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import time
from dataclasses import asdict, dataclass
from datetime import date
from pathlib import Path
from typing import Any

import psycopg

try:
    from dotenv import load_dotenv
except ImportError:  # pragma: no cover - the project normally has python-dotenv
    load_dotenv = None


PROJECT_ROOT = Path(__file__).resolve().parent.parent
EVENT_COLUMNS = (
    "insert_id",
    "event_name",
    "event_time",
    "distinct_id",
    "user_id",
    "uc_uuid",
    "email",
    "company_id",
    "company",
    "properties",
    "ingested_at",
)
TABLE_RE = r"^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$"
REFRESH_LIMIT_SECONDS = 140.0


class CutoverError(RuntimeError):
    """A cutover gate failed."""


@dataclass(frozen=True)
class CopyResult:
    free_events: int
    pro_events: int
    free_day_checksum: str
    pro_day_checksum: str
    day_count: int


def _load_local_env() -> None:
    if load_dotenv is not None:
        load_dotenv(PROJECT_ROOT / ".env", override=False)


def _database_url(name: str, *, required: bool = True) -> str | None:
    value = os.environ.get(name)
    if value:
        return value
    if required:
        raise CutoverError(f"missing {name}")
    return None


def _validate_table(table: str) -> str:
    import re

    if not re.fullmatch(TABLE_RE, table):
        raise CutoverError(f"unsafe table name: {table!r}")
    return table


def _columns_sql() -> str:
    return ", ".join(EVENT_COLUMNS)


def _connect(url: str) -> psycopg.Connection:
    return psycopg.connect(url)


def row_count(conn: psycopg.Connection, table: str = "public.events") -> int:
    table = _validate_table(table)
    return int(conn.execute(f"SELECT count(*) FROM {table}").fetchone()[0])


def day_counts(
    conn: psycopg.Connection,
    table: str = "public.events",
) -> list[tuple[str, int]]:
    table = _validate_table(table)
    rows = conn.execute(
        f"""
        SELECT
          (date_trunc(
            'day',
            event_time AT TIME ZONE 'Asia/Kolkata'
          ))::date::text AS event_day,
          count(*)::int AS n
        FROM {table}
        GROUP BY 1
        ORDER BY 1
        """
    ).fetchall()
    return [(str(day), int(count)) for day, count in rows]


def day_checksum(rows: list[tuple[str, int]]) -> str:
    payload = "\n".join(f"{day}\t{count}" for day, count in rows)
    return hashlib.md5(payload.encode("utf-8"), usedforsecurity=False).hexdigest()


def copy_events(
    free: psycopg.Connection,
    pro: psycopg.Connection,
    *,
    source_table: str = "public.events",
    target_table: str = "public.events",
) -> CopyResult:
    """Copy one stable source snapshot into an empty target table."""
    source_table = _validate_table(source_table)
    target_table = _validate_table(target_table)

    # The source snapshot must include the count and COPY in one transaction.
    # Set the isolation level before the first statement on either connection.
    free.isolation_level = psycopg.IsolationLevel.REPEATABLE_READ
    free.execute("SET statement_timeout = '15min'")
    pro.execute("SET statement_timeout = '15min'")
    free_count = row_count(free, source_table)
    source_days = day_counts(free, source_table)

    target_count = row_count(pro, target_table)
    if target_count:
        raise CutoverError(
            f"target {target_table} is not empty: {target_count} rows"
        )

    columns = _columns_sql()
    copy_out = (
        f"COPY (SELECT {columns} FROM {source_table}) "
        "TO STDOUT WITH (FORMAT BINARY)"
    )
    copy_in = (
        f"COPY {target_table} ({columns}) "
        "FROM STDIN WITH (FORMAT BINARY)"
    )

    with free.cursor().copy(copy_out) as source, pro.cursor().copy(copy_in) as target:
        for chunk in source:
            target.write(chunk)

    pro.commit()
    target_count_after = row_count(pro, target_table)
    target_days = day_counts(pro, target_table)
    if target_count_after != free_count:
        raise CutoverError(
            f"row count mismatch: free={free_count} pro={target_count_after}"
        )
    if target_days != source_days:
        raise CutoverError("IST event-day counts differ after COPY")

    return CopyResult(
        free_events=free_count,
        pro_events=target_count_after,
        free_day_checksum=day_checksum(source_days),
        pro_day_checksum=day_checksum(target_days),
        day_count=len(source_days),
    )


def _refresh(pro: psycopg.Connection) -> dict[str, Any]:
    started = time.monotonic()
    row = pro.execute(
        """
        SELECT n_activation, n_week, n_cells, n_client,
               n_profile, n_week_action
        FROM public.refresh_retention('public.events')
        """
    ).fetchone()
    elapsed = time.monotonic() - started
    if row is None:
        raise CutoverError("refresh_retention returned no row")
    counts = {
        "n_activation": int(row[0]),
        "n_week": int(row[1]),
        "n_cells": int(row[2]),
        "n_client": int(row[3]),
        "n_profile": int(row[4]),
        "n_week_action": int(row[5]),
    }
    result = {"seconds": round(elapsed, 3), "counts": counts}
    if elapsed > REFRESH_LIMIT_SECONDS:
        raise CutoverError(
            f"refresh_retention exceeded {REFRESH_LIMIT_SECONDS:.0f}s: "
            f"{elapsed:.3f}s"
        )
    return result


def _free_incremental_success_date(free: psycopg.Connection) -> date:
    row = free.execute(
        """
        SELECT last_success_date
        FROM public.export_watermarks
        WHERE job_name = 'incremental' AND status = 'ok'
        """
    ).fetchone()
    if row is None or row[0] is None:
        raise CutoverError("Free has no successful incremental watermark")
    return row[0]


def _upsert_cutover_watermark(
    pro: psycopg.Connection,
    success_date: date,
) -> None:
    pro.execute(
        """
        INSERT INTO public.export_watermarks (
          job_name, last_success_date, last_success_at, status, detail
        )
        VALUES ('incremental', %s, now(), 'ok', 'cutover')
        ON CONFLICT (job_name) DO UPDATE SET
          last_success_date = EXCLUDED.last_success_date,
          status = 'ok',
          detail = 'cutover',
          last_success_at = now()
        """,
        (success_date,),
    )
    pro.commit()


def rebuild_and_mark_watermark(
    free: psycopg.Connection,
    pro: psycopg.Connection,
) -> dict[str, Any]:
    refresh = _refresh(pro)
    pro.commit()
    success_date = _free_incremental_success_date(free)
    _upsert_cutover_watermark(pro, success_date)
    return {
        "refresh": refresh,
        "watermark": {
            "job_name": "incremental",
            "last_success_date": success_date.isoformat(),
            "status": "ok",
            "detail": "cutover",
        },
    }


def _snapshot(conn: psycopg.Connection, week_start: date) -> dict[str, Any]:
    events = row_count(conn)
    days = day_counts(conn)
    client = int(
        conn.execute("SELECT count(*) FROM public.client_company").fetchone()[0]
    )
    activation = int(
        conn.execute(
            "SELECT count(*) FROM public.company_activation"
        ).fetchone()[0]
    )
    week8 = conn.execute(
        """
        SELECT cohort_week::text, cohort_size, retained_count
        FROM public.retention_cells
        WHERE rel_week = 8
          AND cohort_week <= (%s::date - 63)
        ORDER BY cohort_week DESC
        LIMIT 1
        """,
        (week_start,),
    ).fetchone()
    return {
        "events": events,
        "event_day_checksum": day_checksum(days),
        "event_days": len(days),
        "client_company": client,
        "company_activation": activation,
        "week8": (
            {
                "cohort_week": str(week8[0])[:10],
                "cohort_size": int(week8[1]),
                "retained_count": int(week8[2]),
            }
            if week8
            else None
        ),
    }


def prove(free: psycopg.Connection, pro: psycopg.Connection) -> dict[str, Any]:
    stamp = free.execute(
        """
        SELECT
          (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::date,
          date_trunc(
            'week',
            CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata'
          )::date
        """
    ).fetchone()
    as_of_ist, week_start = stamp
    free_snapshot = _snapshot(free, week_start)
    pro_snapshot = _snapshot(pro, week_start)
    matches = free_snapshot == pro_snapshot
    return {
        "as_of_ist": str(as_of_ist),
        "week_start": str(week_start),
        "free": free_snapshot,
        "pro": pro_snapshot,
        "matches": matches,
    }


def _copy_command() -> int:
    free_url = _database_url("FREE_DATABASE_URL", required=False) or _database_url(
        "SUPABASE_DB_URL"
    )
    pro_url = _database_url("PRO_DATABASE_URL")
    assert free_url is not None
    assert pro_url is not None
    with _connect(free_url) as free, _connect(pro_url) as pro:
        result = copy_events(free, pro)
        free.commit()
        print(json.dumps(asdict(result), indent=2))
    return 0


def _rebuild_command() -> int:
    free_url = _database_url("FREE_DATABASE_URL", required=False) or _database_url(
        "SUPABASE_DB_URL"
    )
    pro_url = _database_url("PRO_DATABASE_URL")
    assert free_url is not None
    assert pro_url is not None
    with _connect(free_url) as free, _connect(pro_url) as pro:
        result = rebuild_and_mark_watermark(free, pro)
        print(json.dumps(result, indent=2, default=str))
    return 0


def _prove_command() -> int:
    free_url = _database_url("FREE_DATABASE_URL", required=False) or _database_url(
        "SUPABASE_DB_URL"
    )
    pro_url = _database_url("PRO_DATABASE_URL")
    assert free_url is not None
    assert pro_url is not None
    with _connect(free_url) as free, _connect(pro_url) as pro:
        result = prove(free, pro)
        print(json.dumps(result, indent=2))
    return 0 if result["matches"] else 1


def main(argv: list[str] | None = None) -> int:
    _load_local_env()
    parser = argparse.ArgumentParser(
        description="Copy and prove the Free to Pro events warehouse"
    )
    subparsers = parser.add_subparsers(dest="command", required=True)
    subparsers.add_parser("copy", help="stream events and verify parity")
    subparsers.add_parser(
        "rebuild",
        help="refresh Pro derived tables and set the cutover watermark",
    )
    subparsers.add_parser(
        "prove",
        help="compare Free and Pro at one pinned IST week boundary",
    )
    args = parser.parse_args(argv)
    try:
        if args.command == "copy":
            return _copy_command()
        if args.command == "rebuild":
            return _rebuild_command()
        if args.command == "prove":
            return _prove_command()
    except (CutoverError, psycopg.Error) as error:
        print(f"cutover failed: {error}", file=sys.stderr)
        return 1
    raise AssertionError(f"unknown command: {args.command}")


if __name__ == "__main__":
    raise SystemExit(main())
