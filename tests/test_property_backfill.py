import json
from datetime import date, datetime
from decimal import Decimal

import pytest

from scripts import property_backfill
from scripts.property_backfill import (
    MAX_DATABASE_BYTES,
    MAX_EVENT_GROWTH_BYTES,
    StorageBudgetError,
    StorageSnapshot,
    check_storage_budget,
)


def test_storage_budget_accepts_headroom():
    check_storage_budget(
        StorageSnapshot(database_bytes=MAX_DATABASE_BYTES - 1, events_bytes=1),
        MAX_EVENT_GROWTH_BYTES,
    )


def test_storage_budget_rejects_large_database():
    with pytest.raises(StorageBudgetError, match="above 1.5 GB"):
        check_storage_budget(
            StorageSnapshot(database_bytes=MAX_DATABASE_BYTES + 1, events_bytes=1),
            0,
        )


def test_storage_budget_rejects_event_growth_over_eighty_mb():
    with pytest.raises(StorageBudgetError, match="exceeds 80 MB"):
        check_storage_budget(
            StorageSnapshot(database_bytes=1, events_bytes=1),
            MAX_EVENT_GROWTH_BYTES + 1,
        )


def test_backfill_uses_one_request_pacer_and_resumes_after_watermark():
    source = property_backfill.Path(property_backfill.__file__).read_text()
    assert "pacer = RequestPacer(time.sleep, request_gap_seconds)" in source
    assert "last_ok = get_watermark(product, \"property_backfill\")" in source
    assert "pacer=pacer" in source


def test_dumps_result_serializes_dates_and_decimals():
    text = property_backfill.dumps_result({
        "day": date(2026, 9, 6),
        "as_of": datetime(2026, 9, 7, 5, 34, 0),
        "bytes": Decimal("271191187"),
        "days": [{"day": date(2026, 3, 4), "rows": 12}],
    })
    parsed = json.loads(text)
    assert parsed["day"] == "2026-09-06"
    assert parsed["as_of"].startswith("2026-09-07T05:34:00")
    assert parsed["bytes"] == "271191187"
    assert parsed["days"][0]["day"] == "2026-03-04"


def test_emit_result_stays_ok_when_encoder_raises(monkeypatch, capsys):
    def boom(_payload):
        raise TypeError("Object of type date is not JSON serializable")

    monkeypatch.setattr(property_backfill, "dumps_result", boom)
    assert property_backfill.emit_result({"after": {"events": 354393}}) == 0
    printed = json.loads(capsys.readouterr().out)
    assert parsed_ok(printed)


def parsed_ok(printed: dict) -> bool:
    return printed.get("ok") is True and "print_error" in printed
