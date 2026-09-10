import os
from datetime import date, datetime, timezone
from pathlib import Path

import pytest

from fetcher.parse import EventRow, parse_jsonl


pytestmark = pytest.mark.skipif(
    not os.environ.get("TEST_DATABASE_URL"),
    reason="TEST_DATABASE_URL not set",
)


def _row(**overrides) -> EventRow:
    base = EventRow(
        insert_id="ins_1",
        insert_id_synthesized=False,
        event_name="Login",
        event_time=datetime(2026, 9, 3, 10, 0, tzinfo=timezone.utc),
        distinct_id="u1",
        user_id="user-1",
        uc_uuid="uc-1",
        email="a@example.com",
        company_id="c1",
        company="Acme",
        properties={"time": 1, "$insert_id": "ins_1"},
    )
    return EventRow(**{**base.__dict__, **overrides})


@pytest.fixture()
def conn():
    import psycopg
    from fetcher.load import apply_migration, reset_tables

    db_url = os.environ["TEST_DATABASE_URL"]
    connection = psycopg.connect(db_url, autocommit=True)
    apply_migration(connection, Path("supabase/migrations/001_events.sql"))
    reset_tables(connection)
    yield connection
    connection.close()


def test_upsert_does_not_duplicate_on_reload(conn):
    from fetcher.load import upsert_events

    rows, _stats = parse_jsonl(
        Path("tests/fixtures/sample_day.jsonl").read_text()
    )
    first = upsert_events(conn, rows)
    second = upsert_events(conn, rows)
    count = conn.execute("select count(*) from events").fetchone()[0]
    assert first == 3
    assert second == 0
    assert count == 3


def test_upsert_stores_v1_properties(conn):
    from fetcher.load import upsert_events

    upsert_events(conn, [
        _row(properties={
            "time": 1,
            "$insert_id": "ins_1",
            "companyName": "Keep Co",
            "method": "google",
            "huge": "x" * 200,
        }),
        _row(
            insert_id="ins_2",
            properties={"time": 2, "$insert_id": "ins_2"},
        ),
    ])
    rows = conn.execute(
        "select insert_id, properties from events order by insert_id"
    ).fetchall()
    assert rows == [
        ("ins_1", {"companyName": "Keep Co", "method": "google"}),
        ("ins_2", {}),
    ]


def test_upsert_merges_properties_without_rewriting_identity(conn):
    from fetcher.load import upsert_events

    original = _row(properties={
        "time": 1,
        "$insert_id": "ins_1",
        "companyName": "Keep Co",
        "type": "upload",
    })
    assert upsert_events(conn, [original]) == 1

    enrichment = _row(properties={
        "time": 2,
        "$insert_id": "ins_1",
        "companyName": "",
        "status": "failed",
        "fileName": "drop.xlsx",
    })
    assert upsert_events(conn, [enrichment]) == 0
    row = conn.execute(
        """
        select event_name, event_time, distinct_id, company_id, properties
        from events where insert_id = 'ins_1'
        """
    ).fetchone()
    assert row[:4] == (
        original.event_name,
        original.event_time,
        original.distinct_id,
        original.company_id,
    )
    assert row[4] == {
        "companyName": "Keep Co",
        "type": "upload",
        "status": "Failed",
    }


def test_upsert_skips_and_counts_identity_mismatch(conn):
    from fetcher.load import upsert_events, upsert_events_with_stats

    original = _row(properties={
        "time": 1,
        "$insert_id": "ins_1",
        "companyName": "Keep Co",
    })
    assert upsert_events(conn, [original]) == 1

    mismatch = _row(
        event_name="Upload",
        properties={
            "time": 2,
            "$insert_id": "ins_1",
            "status": "success",
        },
    )
    stats = upsert_events_with_stats(conn, [mismatch])
    assert stats.inserted == 0
    assert stats.identity_mismatches == 1
    assert conn.execute(
        "select properties from events where insert_id = 'ins_1'"
    ).fetchone()[0] == {"companyName": "Keep Co"}


def test_upsert_aborts_before_writing_more_than_ten_identity_mismatches(conn):
    from fetcher.load import (
        IdentityMismatchError,
        upsert_events,
        upsert_events_with_stats,
    )

    originals = [
        _row(
            insert_id=f"ins_{index}",
            properties={"time": index, "$insert_id": f"ins_{index}"},
        )
        for index in range(11)
    ]
    assert upsert_events(conn, originals) == 11
    mismatches = [
        _row(
            insert_id=f"ins_{index}",
            event_name="Upload",
            properties={"time": index, "$insert_id": f"ins_{index}"},
        )
        for index in range(11)
    ]

    with pytest.raises(IdentityMismatchError) as error:
        upsert_events_with_stats(conn, mismatches)

    assert error.value.count == 11
    assert conn.execute("select count(*) from events").fetchone()[0] == 11
    assert conn.execute(
        "select count(*) from events where properties <> '{}'::jsonb"
    ).fetchone()[0] == 0


def test_watermark_updates(conn):
    from fetcher.load import set_watermark

    set_watermark(conn, "backfill", date(2026, 3, 4), "ok")
    set_watermark(conn, "backfill", date(2026, 3, 5), "ok")
    job_name, last_date, status = conn.execute(
        "select job_name, last_success_date, status from export_watermarks"
    ).fetchone()
    assert job_name == "backfill"
    assert last_date == date(2026, 3, 5)
    assert status == "ok"
