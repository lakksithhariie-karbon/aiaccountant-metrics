from datetime import date, datetime, timezone
from pathlib import Path

import pytest

from fetcher.export_client import ExportAuthError
from fetcher.parse import parse_jsonl_line


FIXTURE = Path(__file__).parent / "fixtures" / "sample_day.jsonl"


class RecordingClient:
    def __init__(self, payloads, errors=None):
        self.payloads = payloads
        self.errors = errors or {}
        self.calls = []
        self.request_count = 0
        self.rate_limit_hits = 0

    def export_day(self, day, event_names=None, where=None):
        key = (day, tuple(event_names) if event_names else None, where)
        self.calls.append(key)
        self.request_count += 1
        if key in self.errors:
            raise self.errors[key]
        if key in self.payloads:
            return self.payloads[key]
        if (day, None, None) in self.payloads and event_names is None and where is None:
            return self.payloads[(day, None, None)]
        raise AssertionError(f"unexpected export {key}")


def _conn(db_url):
    import psycopg
    from fetcher.load import apply_migration, reset_tables

    connection = psycopg.connect(db_url, autocommit=True)
    apply_migration(connection, Path("supabase/migrations/001_events.sql"))
    reset_tables(connection)
    return connection


@pytest.fixture()
def conn():
    import os

    db_url = os.environ.get("TEST_DATABASE_URL")
    if not db_url:
        pytest.skip("TEST_DATABASE_URL not set")
    connection = _conn(db_url)
    yield connection
    connection.close()


def test_six_hour_windows_cover_utc_day():
    from fetcher.jobs import six_hour_windows

    day = date(2026, 9, 3)
    windows = six_hour_windows(day)
    assert len(windows) == 4
    start = int(datetime(2026, 9, 3, tzinfo=timezone.utc).timestamp())
    assert windows[0] == (
        f'properties["time"]>={start} and properties["time"]<{start + 6 * 3600}'
    )
    assert str(start + 18 * 3600) in windows[3]


def test_load_day_upserts_and_returns_counts(conn):
    from fetcher.jobs import load_day

    day = date(2026, 9, 3)
    client = RecordingClient({(day, None, None): FIXTURE.read_text()})
    result = load_day(client, conn, day, sleep=lambda _s: None, request_gap_seconds=0)
    count = conn.execute("select count(*) from events").fetchone()[0]
    assert result.rows == 3
    assert result.inserted == 3
    assert result.synthesized == 1
    assert "Sign Up" in result.event_names
    assert result.pct_company_id == 100.0
    assert count == 3


def test_prove_day_second_pass_inserts_nothing(conn):
    from fetcher.jobs import prove_day

    day = date(2026, 9, 3)
    client = RecordingClient({(day, None, None): FIXTURE.read_text()})
    first, second = prove_day(
        client, conn, day, sleep=lambda _s: None, request_gap_seconds=0
    )
    count = conn.execute("select count(*) from events").fetchone()[0]
    assert first.inserted == 3
    assert second.inserted == 0
    assert second.rows == first.rows
    assert count == 3


def test_load_day_splits_by_known_and_probe_events(conn, monkeypatch):
    from fetcher import jobs

    monkeypatch.setattr(jobs, "needs_split", lambda text: text.startswith("FAT"))
    day = date(2026, 9, 3)
    signup = FIXTURE.read_text().splitlines()[0]
    sync = FIXTURE.read_text().splitlines()[1]
    extra = (
        '{"event":"Brand New Event","properties":{"time":1756950000,'
        '"$insert_id":"ins_new","distinct_id":"u9","companyId":"c9"}}'
    )
    fat = "FAT\n" + signup + "\n" + extra
    client = RecordingClient(
        {
            (day, None, None): fat,
            (day, ("Sign Up",), None): signup,
            (day, ("Accounting Sync",), None): sync,
            (day, ("Brand New Event",), None): extra,
            **{
                (day, (name,), None): ""
                for name in jobs.KNOWN_EVENTS
                if name not in {"Sign Up", "Accounting Sync"}
            },
        }
    )
    result = jobs.load_day(
        client, conn, day, sleep=lambda _s: None, request_gap_seconds=0
    )
    names_requested = {call[1][0] for call in client.calls if call[1]}
    assert "Sign Up" in names_requested
    assert "Brand New Event" in names_requested
    assert result.rows == 3
    assert result.split is True


def test_load_day_splits_hot_event_into_six_hour_windows(conn, monkeypatch):
    from fetcher import jobs

    def fake_needs_split(text):
        return text.startswith("FAT")

    monkeypatch.setattr(jobs, "needs_split", fake_needs_split)
    day = date(2026, 9, 3)
    windows = jobs.six_hour_windows(day)
    line = FIXTURE.read_text().splitlines()[0]
    payloads = {
        (day, None, None): "FAT",
        (day, ("Sign Up",), None): "FAT",
        (day, ("Sign Up",), windows[0]): line,
        **{(day, ("Sign Up",), w): "" for w in windows[1:]},
        **{
            (day, (name,), None): ""
            for name in jobs.KNOWN_EVENTS
            if name != "Sign Up"
        },
    }
    client = RecordingClient(payloads)
    result = jobs.load_day(
        client, conn, day, sleep=lambda _s: None, request_gap_seconds=0
    )
    assert (day, ("Sign Up",), windows[0]) in client.calls
    assert result.rows == 1
    assert result.split is True


def test_backfill_advances_watermark_and_pauses_between_requests(conn):
    from fetcher.jobs import backfill

    slept = []
    d1 = date(2026, 3, 4)
    d2 = date(2026, 3, 5)
    client = RecordingClient(
        {
            (d1, None, None): FIXTURE.read_text(),
            (d2, None, None): FIXTURE.read_text(),
        }
    )
    backfill(
        client,
        conn,
        start=d1,
        end=d2,
        sleep=slept.append,
        request_gap_seconds=120,
    )
    last = conn.execute(
        "select last_success_date, status from export_watermarks where job_name = 'backfill'"
    ).fetchone()
    assert last[0] == d2
    assert last[1] == "ok"
    assert 120 in slept


def test_backfill_does_not_advance_watermark_on_auth_error(conn):
    from fetcher.jobs import backfill

    d1 = date(2026, 3, 4)
    d2 = date(2026, 3, 5)
    client = RecordingClient(
        {(d1, None, None): FIXTURE.read_text()},
        errors={(d2, None, None): ExportAuthError("nope")},
    )
    with pytest.raises(ExportAuthError):
        backfill(
            client,
            conn,
            start=d1,
            end=d2,
            sleep=lambda _s: None,
            request_gap_seconds=0,
        )
    last = conn.execute(
        "select last_success_date, status, detail from export_watermarks where job_name = 'backfill'"
    ).fetchone()
    assert last[0] == d1
    assert last[1] == "failed"
    assert last[2]


def test_incremental_loads_yesterday_and_today(conn):
    from fetcher.jobs import incremental

    today = date(2026, 9, 4)
    yesterday = date(2026, 9, 3)
    client = RecordingClient(
        {
            (yesterday, None, None): FIXTURE.read_text(),
            (today, None, None): FIXTURE.read_text(),
        }
    )
    incremental(
        client,
        conn,
        today=today,
        sleep=lambda _s: None,
        request_gap_seconds=0,
    )
    days = {
        call[0] for call in client.calls
    }
    assert days == {yesterday, today}
    last = conn.execute(
        "select last_success_date, status from export_watermarks where job_name = 'incremental'"
    ).fetchone()
    assert last[0] == today
    assert last[1] == "ok"


def test_incremental_failure_keeps_previous_success_date(conn):
    from fetcher.export_client import ExportAuthError
    from fetcher.jobs import incremental
    from fetcher.load import set_watermark

    today = date(2026, 9, 4)
    yesterday = date(2026, 9, 3)
    set_watermark(conn, "incremental", yesterday, "ok")
    client = RecordingClient(
        {},
        errors={(yesterday, None, None): ExportAuthError("nope")},
    )
    with pytest.raises(ExportAuthError):
        incremental(
            client,
            conn,
            today=today,
            sleep=lambda _s: None,
            request_gap_seconds=0,
        )
    last = conn.execute(
        "select last_success_date, status, detail from export_watermarks where job_name = 'incremental'"
    ).fetchone()
    assert last[0] == yesterday
    assert last[1] == "failed"
    assert last[2]


def test_load_day_logs_do_not_contain_email(conn, caplog):
    import logging

    from fetcher.jobs import load_day

    caplog.set_level(logging.INFO)
    day = date(2026, 9, 3)
    client = RecordingClient({(day, None, None): FIXTURE.read_text()})
    load_day(client, conn, day, sleep=lambda _s: None, request_gap_seconds=0)
    joined = "\n".join(record.getMessage() for record in caplog.records)
    email = parse_jsonl_line(FIXTURE.read_text().splitlines()[0]).email
    assert email not in joined
    assert "2026-09-03" in joined


def test_parse_args_prove_day():
    from fetcher.cli import parse_args

    ns = parse_args(["prove-day", "--date", "2026-09-03"])
    assert ns.command == "prove-day"
    assert ns.date == date(2026, 9, 3)


def test_parse_args_backfill_and_incremental():
    from fetcher.cli import parse_args

    backfill_ns = parse_args(
        ["backfill", "--from", "2026-03-04", "--to", "2026-09-03"]
    )
    assert backfill_ns.command == "backfill"
    assert backfill_ns.from_date == date(2026, 3, 4)
    assert backfill_ns.to_date == date(2026, 9, 3)
    inc = parse_args(["incremental"])
    assert inc.command == "incremental"
    gap = parse_args(["prove-day", "--date", "2026-09-03", "--request-gap", "0"])
    assert gap.request_gap == 0
