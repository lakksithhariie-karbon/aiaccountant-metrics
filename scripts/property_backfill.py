"""Run the controlled event-property enrichment window on Pro.

The command is intentionally separate from the hourly incremental job. It
uses one sequential Mixpanel exporter, records ``property_backfill`` progress,
and restores the Vault-backed Pro cron in a ``finally`` block.
"""

from __future__ import annotations

import argparse
import json
import os
import time
from contextlib import contextmanager
from dataclasses import asdict, dataclass
from datetime import date, datetime, timedelta
from decimal import Decimal
from pathlib import Path
from typing import Iterator
from zoneinfo import ZoneInfo

import psycopg
from dotenv import load_dotenv

from fetcher.cli import client_from_env
from fetcher.jobs import RequestPacer, load_day
from fetcher.load import get_watermark, set_watermark
from scripts.cutover_copy_events import day_checksum, day_counts

PROJECT_ROOT = Path(__file__).resolve().parent.parent
CRON_MIGRATION = PROJECT_ROOT / "supabase/migrations/009_cron_url_from_vault.sql"
IST = ZoneInfo("Asia/Kolkata")
MAX_DATABASE_BYTES = 1_500_000_000
MAX_EVENT_GROWTH_BYTES = 80 * 1024 * 1024


class StorageBudgetError(RuntimeError):
    pass


def json_default(value: object) -> str:
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, date):
        return value.isoformat()
    if isinstance(value, Decimal):
        return format(value, "f")
    return str(value)


def dumps_result(payload: object) -> str:
    return json.dumps(payload, default=json_default, sort_keys=True)


def emit_result(result: dict[str, object]) -> int:
    """Print the backfill report. A printer bug must not look like a failed window."""
    try:
        print(dumps_result(result))
    except Exception as exc:  # noqa: BLE001 - printer must not fail the job
        print(json.dumps({"ok": True, "print_error": str(exc)}, default=str))
    return 0


@dataclass(frozen=True)
class StorageSnapshot:
    database_bytes: int
    events_bytes: int


def load_env() -> None:
    load_dotenv(PROJECT_ROOT / ".env", override=False)


def ist_today() -> date:
    return datetime.now(IST).date()


def storage_snapshot(conn: psycopg.Connection) -> StorageSnapshot:
    row = conn.execute(
        """
        SELECT
          pg_database_size(current_database()),
          pg_total_relation_size('public.events')
        """
    ).fetchone()
    return StorageSnapshot(database_bytes=int(row[0]), events_bytes=int(row[1]))


def check_storage_budget(
    snapshot: StorageSnapshot,
    estimated_growth_bytes: int,
) -> None:
    if snapshot.database_bytes > MAX_DATABASE_BYTES:
        raise StorageBudgetError(
            f"database is above 1.5 GB: {snapshot.database_bytes} bytes"
        )
    if estimated_growth_bytes > MAX_EVENT_GROWTH_BYTES:
        raise StorageBudgetError(
            "estimated events growth exceeds 80 MB: "
            f"{estimated_growth_bytes} bytes"
        )


def prove_snapshot(conn: psycopg.Connection) -> dict[str, object]:
    as_of_ist, week_start = conn.execute(
        """
        SELECT
          (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::date,
          date_trunc('week', CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::date
        """
    ).fetchone()
    days = day_counts(conn)
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
        "as_of_ist": str(as_of_ist),
        "week_start": str(week_start),
        "events": int(conn.execute("SELECT count(*) FROM public.events").fetchone()[0]),
        "event_day_checksum": day_checksum(days),
        "client_company": int(
            conn.execute("SELECT count(*) FROM public.client_company").fetchone()[0]
        ),
        "company_activation": int(
            conn.execute("SELECT count(*) FROM public.company_activation").fetchone()[0]
        ),
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


def unschedule_ingest(admin: psycopg.Connection) -> int | None:
    row = admin.execute(
        "SELECT jobid FROM cron.job WHERE jobname = 'sync-incremental-hourly'"
    ).fetchone()
    if row is not None:
        admin.execute("SELECT cron.unschedule(%s)", (row[0],))
        return int(row[0])
    return None


def restore_ingest(admin: psycopg.Connection) -> None:
    # This is the exact Vault-backed schedule migration. It unschedules any
    # duplicate first and never falls back to the Free hostname.
    admin.execute(CRON_MIGRATION.read_text())


@contextmanager
def paused_ingest(admin: psycopg.Connection) -> Iterator[int | None]:
    job_id = unschedule_ingest(admin)
    try:
        yield job_id
    finally:
        restore_ingest(admin)


def each_day(start: date, end: date):
    current = start
    while current <= end:
        yield current
        current += timedelta(days=1)


def run_backfill(
    product: psycopg.Connection,
    admin: psycopg.Connection,
    *,
    start: date,
    end: date,
    request_gap_seconds: float,
    estimated_growth_bytes: int,
) -> dict[str, object]:
    before_storage = storage_snapshot(product)
    check_storage_budget(before_storage, estimated_growth_bytes)
    before = prove_snapshot(product)
    client = client_from_env()
    stats: list[dict[str, object]] = []
    last_ok = get_watermark(product, "property_backfill")
    resume_from = start
    if last_ok is not None and last_ok >= start:
        resume_from = last_ok + timedelta(days=1)
    pacer = RequestPacer(time.sleep, request_gap_seconds)

    with paused_ingest(admin) as job_id:
        try:
            for day in each_day(resume_from, end):
                result = load_day(
                    client,
                    product,
                    day,
                    sleep=time.sleep,
                    request_gap_seconds=request_gap_seconds,
                    pacer=pacer,
                )
                detail = dumps_result(asdict(result))
                set_watermark(product, "property_backfill", day, "ok", detail)
                stats.append(asdict(result))
                last_ok = day

            # Catch up yesterday + today while cron is still paused, so the
            # resumed schedule cannot race this one writer.
            from fetcher.jobs import incremental

            if stats:
                time.sleep(request_gap_seconds)
            incremental(
                client,
                product,
                today=ist_today(),
                sleep=time.sleep,
                request_gap_seconds=request_gap_seconds,
            )
        except Exception as error:
            set_watermark(
                product,
                "property_backfill",
                last_ok,
                "failed",
                str(error),
            )
            raise

    after = prove_snapshot(product)
    if after["events"] < before["events"]:
        raise RuntimeError(
            f"event count dropped during property backfill: "
            f"before={before['events']} after={after['events']}"
        )
    after_storage = storage_snapshot(product)
    return {
        "job_id_before_pause": job_id,
        "before_storage": asdict(before_storage),
        "after_storage": asdict(after_storage),
        "before": before,
        "after": after,
        "days": stats,
    }


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    budget = sub.add_parser("budget")
    budget.add_argument("--estimated-growth-mb", type=float, required=True)

    backfill = sub.add_parser("backfill")
    backfill.add_argument("--admin-database-url", required=True)
    backfill.add_argument("--from-date", type=date.fromisoformat, default=date(2026, 3, 4))
    backfill.add_argument("--to-date", type=date.fromisoformat, default=ist_today() - timedelta(days=1))
    backfill.add_argument("--estimated-growth-mb", type=float, required=True)
    backfill.add_argument("--request-gap", type=float, default=120.0)
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    load_env()
    args = parse_args(argv)
    product_url = os.environ.get("SUPABASE_DB_URL")
    if not product_url:
        raise SystemExit("missing SUPABASE_DB_URL")

    if args.command == "budget":
        with psycopg.connect(product_url, autocommit=True) as product:
            snapshot = storage_snapshot(product)
        estimated = int(args.estimated_growth_mb * 1024 * 1024)
        check_storage_budget(snapshot, estimated)
        print(dumps_result({"storage": asdict(snapshot), "estimated_growth_bytes": estimated}))
        return 0

    with (
        psycopg.connect(product_url, autocommit=True) as product,
        psycopg.connect(args.admin_database_url, autocommit=True) as admin,
    ):
        result = run_backfill(
            product,
            admin,
            start=args.from_date,
            end=args.to_date,
            request_gap_seconds=args.request_gap,
            estimated_growth_bytes=int(args.estimated_growth_mb * 1024 * 1024),
        )
    return emit_result(result)


if __name__ == "__main__":
    raise SystemExit(main())
