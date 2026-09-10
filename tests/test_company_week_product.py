"""Gate 4 company x IST-week product flag tests."""

from __future__ import annotations

import json
import os
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal

import pytest

TEST_DB_URL = os.environ.get(
    "TEST_DATABASE_URL",
    "postgresql://postgres:postgres@127.0.0.1:5432/product_metrics",
)
IST = timezone(timedelta(hours=5, minutes=30))
ROOT = os.path.dirname(os.path.dirname(__file__))
MIGRATION_001 = os.path.join(ROOT, "supabase/migrations/001_events.sql")
MIGRATION_012 = os.path.join(
    ROOT, "supabase/migrations/012_company_week_product.sql"
)


@pytest.fixture()
def conn():
    import psycopg

    from metrics.refresh import ensure_tables

    connection = psycopg.connect(TEST_DB_URL, autocommit=True)
    connection.execute(open(MIGRATION_001).read())
    ensure_tables(connection)
    if connection.execute(
        "SELECT to_regprocedure('public.refresh_company_week_product(text)')"
    ).fetchone()[0] is None:
        connection.execute(open(MIGRATION_012).read())
    connection.execute(
        "DELETE FROM public.events WHERE insert_id LIKE 'product_flag_%'"
    )
    yield connection
    connection.execute(
        "DELETE FROM public.events WHERE insert_id LIKE 'product_flag_%'"
    )
    connection.close()


_seq = 0


def at(day: date, hour: int = 10) -> datetime:
    return datetime(day.year, day.month, day.day, hour, 0, tzinfo=IST)


def add_event(connection, event_name, event_time, company_id, *, email,
              properties=None):
    global _seq
    _seq += 1
    connection.execute(
        """
        INSERT INTO public.events (
          insert_id, event_name, event_time, distinct_id, email,
          company_id, company, properties
        )
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s::jsonb)
        """,
        (
            f"product_flag_{_seq}",
            event_name,
            event_time,
            f"product-user-{_seq}",
            email,
            company_id,
            company_id,
            json.dumps(properties or {}),
        ),
    )


def refresh(connection):
    from metrics.refresh import rebuild

    return rebuild(connection, source="public.events")


def test_company_week_product_flags_and_qa_coverage(conn):
    week = date(2025, 1, 6)
    client_email = "accountant@example.com"

    # Multiple independent formulas are true for one company in one week.
    add_event(
        conn, "Upload", at(week), "c_flags", email=client_email,
        properties={"type": "invoice", "status": "Success"},
    )
    add_event(
        conn, "Upload", at(week, 11), "c_flags", email=client_email,
        properties={"type": "bill", "status": "Failed"},
    )
    add_event(
        conn, "Upload", at(week, 12), "c_flags", email=client_email,
        properties={"type": "statement", "status": "Success"},
    )
    add_event(
        conn, "Upload", at(week, 13), "c_flags", email=client_email,
        properties={"type": "gstr2b", "status": "Success"},
    )
    add_event(
        conn, "Entity Created", at(week, 14), "c_flags", email=client_email,
        properties={"entityType": "bill"},
    )
    add_event(
        conn, "Transaction Status", at(week, 15), "c_flags", email=client_email,
        properties={"status": "Accounting Ready"},
    )

    # A failed upload cannot create a product row by itself.
    add_event(
        conn, "Upload", at(week), "c_failed", email=client_email,
        properties={"type": "invoice", "status": "Failed"},
    )
    # An absent type is counted by coverage but creates no product flag.
    add_event(
        conn, "Upload", at(week), "c_untyped", email=client_email,
        properties={"status": "Success"},
    )
    # Staff-only companies must stay out of flags and coverage.
    add_event(
        conn, "Upload", at(week), "c_staff", email="ops@karboncard.com",
        properties={"type": "invoice", "status": "Success"},
    )

    before_events = conn.execute("SELECT count(*) FROM public.events").fetchone()[0]
    refresh(conn)
    after_events = conn.execute("SELECT count(*) FROM public.events").fetchone()[0]
    assert after_events == before_events

    row = conn.execute(
        """
        SELECT had_uploaded_excel, had_ap_active, had_txn_active,
               had_gst_recon, had_created_bill_or_txn,
               had_bill_upload, had_invoice_upload, had_statement_upload
        FROM public.company_week_product
        WHERE company_id = 'c_flags' AND week_start = %s
        """,
        (week,),
    ).fetchone()
    assert row == (True, True, True, True, True, False, True, True)
    assert conn.execute(
        "SELECT count(*) FROM public.company_week_product "
        "WHERE company_id IN ('c_failed', 'c_untyped', 'c_staff')"
    ).fetchone()[0] == 0

    qa = conn.execute(
        """
        SELECT had_uploaded_excel, had_ap_active, had_txn_active,
               had_gst_recon, had_created_bill_or_txn,
               had_bill_upload, had_invoice_upload, had_statement_upload
        FROM public.company_week_product_qa
        WHERE company_id = 'c_flags' AND week_start = %s
        """,
        (week,),
    ).fetchone()
    assert qa == row

    coverage = conn.execute(
        """
        SELECT total_uploads, typed_uploads, untyped_uploads, coverage_pct
        FROM public.upload_type_coverage_qa
        WHERE week_start = %s
        """,
        (week,),
    ).fetchone()
    assert coverage[:3] == (6, 5, 1)
    assert Decimal(coverage[3]) == Decimal("83.3")
