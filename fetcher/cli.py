from __future__ import annotations

import argparse
import logging
import os
import time
from datetime import date, datetime
from zoneinfo import ZoneInfo

import psycopg
from dotenv import load_dotenv

from fetcher.export_client import ExportClient
from fetcher.jobs import (
    DEFAULT_REQUEST_GAP_SECONDS,
    backfill,
    incremental,
    prove_day,
)
from fetcher.load import apply_migration

log = logging.getLogger("fetcher")
IST = ZoneInfo("Asia/Kolkata")


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="metrics-fetcher",
        description="Copy Mixpanel events into Postgres",
    )
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument(
        "--request-gap",
        type=float,
        default=DEFAULT_REQUEST_GAP_SECONDS,
        help="Seconds to wait between Mixpanel export requests (default 120)",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    prove = sub.add_parser(
        "prove-day",
        parents=[common],
        help="Export and load one day twice",
    )
    prove.add_argument("--date", type=date.fromisoformat, required=True)

    fill = sub.add_parser(
        "backfill",
        parents=[common],
        help="Load a date range, one day at a time",
    )
    fill.add_argument("--from", dest="from_date", type=date.fromisoformat, required=True)
    fill.add_argument("--to", dest="to_date", type=date.fromisoformat, required=True)

    sub.add_parser(
        "incremental",
        parents=[common],
        help="Load yesterday and today",
    )
    return parser.parse_args(argv)


def _require_env(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise SystemExit(f"missing env {name}")
    return value


def client_from_env() -> ExportClient:
    return ExportClient(
        project_id=int(_require_env("MIXPANEL_PROJECT_ID")),
        username=_require_env("MIXPANEL_SA_USERNAME"),
        secret=_require_env("MIXPANEL_SA_SECRET"),
    )


def connect(url: str) -> psycopg.Connection:
    conn = psycopg.connect(url, autocommit=True)
    apply_migration(conn)
    return conn


def _print_day(label: str, result) -> None:
    print(
        f"{label} day={result.day.isoformat()} rows={result.rows} "
        f"inserted={result.inserted} events={len(result.event_names)} "
        f"company_id_pct={result.pct_company_id:.1f} "
        f"real_insert_id_pct={result.pct_real_insert_id:.1f} "
        f"synthesized={result.synthesized} requests={result.request_count} "
        f"429s={result.rate_limit_hits} "
        f"identity_mismatches={getattr(result, 'identity_mismatches', 0)} "
        f"split={result.split}"
    )


def main(argv: list[str] | None = None) -> int:
    load_dotenv(override=True)
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    args = parse_args(argv)
    client = client_from_env()
    conn = connect(_require_env("SUPABASE_DB_URL"))
    try:
        if args.command == "prove-day":
            first, second = prove_day(
                client,
                conn,
                args.date,
                sleep=time.sleep,
                request_gap_seconds=args.request_gap,
            )
            _print_day("first", first)
            _print_day("reload", second)
            if second.rows != first.rows:
                print("reload row count changed; stop and inspect")
                return 1
            return 0
        if args.command == "backfill":
            backfill(
                client,
                conn,
                start=args.from_date,
                end=args.to_date,
                sleep=time.sleep,
                request_gap_seconds=args.request_gap,
            )
            return 0
        if args.command == "incremental":
            incremental(
                client,
                conn,
                today=datetime.now(IST).date(),
                sleep=time.sleep,
                request_gap_seconds=args.request_gap,
            )
            return 0
        raise SystemExit(f"unknown command {args.command}")
    finally:
        conn.close()


if __name__ == "__main__":
    raise SystemExit(main())
