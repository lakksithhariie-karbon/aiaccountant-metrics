from pathlib import Path

from fetcher.parse import (
    EVENT_PROPERTY_ALLOWLIST,
    merge_properties,
    parse_jsonl,
    parse_jsonl_line,
    warehouse_properties,
)


FIXTURE = Path(__file__).parent / "fixtures" / "sample_day.jsonl"


def test_maps_insert_id_event_name_and_join_keys():
    row = parse_jsonl_line(FIXTURE.read_text().splitlines()[0])
    assert row.insert_id == "ins_signup_1"
    assert row.insert_id_synthesized is False
    assert row.event_name == "Sign Up"
    assert row.distinct_id == "u1"
    assert row.user_id == "user-1"
    assert row.uc_uuid == "uc-1"
    assert row.email == "a@example.com"
    assert row.company_id == "c1"
    assert row.company == "Acme"
    assert row.properties["method"] == "google"
    assert row.event_time.year == 2025


def test_prefers_userId_when_dollar_user_id_missing():
    row = parse_jsonl_line(FIXTURE.read_text().splitlines()[1])
    assert row.user_id == "user-1"
    assert row.company_id == "99"


def test_synthesizes_stable_insert_id_when_missing():
    line = FIXTURE.read_text().splitlines()[2]
    first = parse_jsonl_line(line)
    second = parse_jsonl_line(line)
    assert first.insert_id_synthesized is True
    assert first.insert_id == second.insert_id
    assert first.insert_id.startswith("syn_")
    assert first.event_name == "Upload"


def test_parse_jsonl_skips_blank_lines_and_counts_synthesized():
    text = FIXTURE.read_text() + "\n\n"
    rows, stats = parse_jsonl(text)
    assert len(rows) == 3
    assert stats.synthesized_insert_ids == 1
    assert stats.with_company_id == 3
    assert stats.with_real_insert_id == 2


def test_event_properties_v1_allowlist_and_normalization():
    uuid_value = "ABCDEFAB-1234-4ABC-8ABC-ABCDEFABCDEF"
    raw = {
        "companyName": "Acme",
        "type": " GST2B ",
        "subType": " unexpected ",
        "status": "success",
        "fileType": "text/csv",
        "source": " Header ",
        "entityType": " bill ",
        "transactionType": uuid_value,
        "action": " Save ",
        "productCode": " aia ",
        "widgetName": " Upload ",
        "flow": " Sign Up ",
        "method": " GOOGLE ",
        "viewSource": " Dashboard ",
        "isReactivation": True,
        "items_count": 12,
        "fileName": "sensitive.xlsx",
        "gstin": "should-drop",
        "sync_items": {"large": True},
        "time": 1756944000,
        "$insert_id": "insert-1",
        "distinct_id": "user-1",
        "companyId": "company-1",
    }

    normalized = warehouse_properties(raw, event_name="Upload")

    assert set(normalized) == EVENT_PROPERTY_ALLOWLIST
    assert normalized == {
        "companyName": "Acme",
        "type": "gstr2b",
        "subType": "bank",
        "status": "Success",
        "fileType": "text/csv",
        "source": "Header",
        "entityType": "bill",
        "transactionType": uuid_value,
        "action": "Save",
        "productCode": "aia",
        "widgetName": "Upload",
        "flow": "Sign Up",
        "method": "GOOGLE",
        "viewSource": "Dashboard",
        "isReactivation": True,
        "items_count": 12,
    }


def test_event_properties_v1_drops_invalid_boolean_and_number_values():
    normalized = warehouse_properties(
        {"isReactivation": "true", "items_count": "12"},
        event_name="Accounting Sync",
    )
    assert normalized == {}


def test_merge_properties_preserves_name_and_drops_unknown_keys():
    merged = merge_properties(
        {"companyName": "Keep Co", "type": "upload"},
        {"companyName": "", "status": "Failed", "fileName": "drop.xlsx"},
    )
    assert merged == {
        "companyName": "Keep Co",
        "type": "upload",
        "status": "Failed",
    }
