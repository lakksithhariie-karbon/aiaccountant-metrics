import os

import pytest

from scripts.cutover_copy_events import (
    CutoverError,
    copy_events,
    day_counts,
    row_count,
)


pytestmark = pytest.mark.skipif(
    not os.environ.get("TEST_DATABASE_URL"),
    reason="TEST_DATABASE_URL not set",
)


@pytest.fixture()
def copy_tables():
    import psycopg

    url = os.environ["TEST_DATABASE_URL"]
    conn = psycopg.connect(url, autocommit=True)
    conn.execute("DROP SCHEMA IF EXISTS cutover_target CASCADE")
    conn.execute("DROP SCHEMA IF EXISTS cutover_source CASCADE")
    conn.execute("CREATE SCHEMA cutover_source")
    conn.execute("CREATE SCHEMA cutover_target")
    conn.execute(
        """
        CREATE TABLE cutover_source.events
        (LIKE public.events INCLUDING ALL)
        """
    )
    conn.execute(
        """
        CREATE TABLE cutover_target.events
        (LIKE public.events INCLUDING ALL)
        """
    )
    conn.execute(
        """
        INSERT INTO cutover_source.events (
          insert_id, event_name, event_time, distinct_id,
          company_id, company, properties, ingested_at
        )
        VALUES
          (
            'copy_a', 'Upload', '2026-09-01T03:00:00Z',
            'user-a', 'company-a', 'company-a', '{"companyName":"A"}',
            '2026-09-01T03:01:00Z'
          ),
          (
            'copy_b', 'Accounting Sync', '2026-09-02T03:00:00Z',
            'user-a', 'company-a', 'company-a', '{}',
            '2026-09-02T03:01:00Z'
          )
        """
    )
    yield conn
    conn.execute("DROP SCHEMA IF EXISTS cutover_target CASCADE")
    conn.execute("DROP SCHEMA IF EXISTS cutover_source CASCADE")
    conn.close()


def test_copy_streams_named_rows_and_checks_ist_day_counts(copy_tables):
    import psycopg

    url = os.environ["TEST_DATABASE_URL"]
    source = psycopg.connect(url)
    target = psycopg.connect(url)
    try:
        result = copy_events(
            source,
            target,
            source_table="cutover_source.events",
            target_table="cutover_target.events",
        )
        assert result.free_events == result.pro_events == 2
        assert result.free_day_checksum == result.pro_day_checksum
        assert day_counts(source, "cutover_source.events") == day_counts(
            target, "cutover_target.events"
        )
        assert row_count(target, "cutover_target.events") == 2
    finally:
        source.close()
        target.close()


def test_copy_aborts_when_target_is_not_empty(copy_tables):
    import psycopg

    url = os.environ["TEST_DATABASE_URL"]
    source = psycopg.connect(url)
    target = psycopg.connect(url)
    try:
        target.execute(
            """
            INSERT INTO cutover_target.events
              (insert_id, event_name, event_time, distinct_id, properties)
            VALUES ('already-there', 'Login', now(), 'user', '{}')
            """
        )
        target.commit()
        with pytest.raises(CutoverError, match="not empty"):
            copy_events(
                source,
                target,
                source_table="cutover_source.events",
                target_table="cutover_target.events",
            )
    finally:
        source.close()
        target.close()
