from __future__ import annotations

import hashlib
import json
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import datetime, timezone
from math import isfinite
from typing import Any
from uuid import UUID


EVENT_PROPERTIES_VERSION = "event_properties.v1"

# Keep this list explicit. Mixpanel identity fields remain warehouse columns,
# not event properties. Additions require a new reviewed dictionary version.
EVENT_PROPERTY_ALLOWLIST = frozenset(
    {
        "companyName",
        "type",
        "subType",
        "status",
        "fileType",
        "source",
        "entityType",
        "transactionType",
        "action",
        "productCode",
        "widgetName",
        "flow",
        "method",
        "viewSource",
        "isReactivation",
        "items_count",
    }
)

_PROPERTY_ORDER = (
    "companyName",
    "type",
    "subType",
    "status",
    "fileType",
    "source",
    "entityType",
    "transactionType",
    "action",
    "productCode",
    "widgetName",
    "flow",
    "method",
    "viewSource",
    "isReactivation",
    "items_count",
)
_UPLOAD_SUBTYPES = frozenset({"bulk", "single", "gst_reconciliation"})


@dataclass(frozen=True)
class ParseStats:
    synthesized_insert_ids: int
    with_company_id: int
    with_real_insert_id: int


@dataclass(frozen=True)
class EventRow:
    insert_id: str
    insert_id_synthesized: bool
    event_name: str
    event_time: datetime
    distinct_id: str
    user_id: str | None
    uc_uuid: str | None
    email: str | None
    company_id: str | None
    company: str | None
    properties: dict[str, Any]


def _as_text(value: Any) -> str | None:
    if value is None or value == "":
        return None
    return str(value)


def _trimmed_text(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _uuid_value(value: Any) -> str | None:
    text = _trimmed_text(value)
    if text is None:
        return None
    try:
        UUID(text)
    except (ValueError, AttributeError):
        return text.lower()
    return text


def _items_count(value: Any) -> int | float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    if isinstance(value, float) and not isfinite(value):
        return None
    return value


def warehouse_properties(
    properties: Mapping[str, Any], event_name: str | None = None
) -> dict[str, Any]:
    """Return canonical ``event_properties.v1`` data for the warehouse."""
    normalized: dict[str, Any] = {}

    # Preserve the existing companyName behavior. An empty name is omitted so
    # a merge cannot erase a previously known display name.
    name = _trimmed_text(properties.get("companyName"))
    if name:
        normalized["companyName"] = name

    for key in _PROPERTY_ORDER[1:]:
        if key not in properties:
            continue
        value = properties[key]
        if key == "isReactivation":
            if type(value) is bool:
                normalized[key] = value
            continue
        if key == "items_count":
            number = _items_count(value)
            if number is not None:
                normalized[key] = number
            continue

        text = _trimmed_text(value)
        if text is None:
            continue
        if key == "type":
            text = text.lower()
            if text == "gst2b":
                text = "gstr2b"
        elif key == "subType":
            text = text.lower()
            if event_name == "Upload" and text not in _UPLOAD_SUBTYPES:
                text = "bank"
        elif key == "status":
            text = {"success": "Success", "failed": "Failed"}.get(text, text)
        elif key == "transactionType":
            text = _uuid_value(text) or text
        elif key in {
            "entityType",
            "productCode",
            "action",
            "method",
            "flow",
            "viewSource",
            "widgetName",
        }:
            pass
        normalized[key] = text

    return normalized


def merge_properties(
    old: Mapping[str, Any] | None,
    new_allowlisted: Mapping[str, Any] | None,
) -> dict[str, Any]:
    """Merge v1 properties without allowing an empty companyName to erase one."""
    merged = dict(old or {})
    for key, value in (new_allowlisted or {}).items():
        if key not in EVENT_PROPERTY_ALLOWLIST:
            continue
        if key == "companyName" and not _as_text(value):
            continue
        merged[key] = value
    return merged


def _event_time(properties: dict[str, Any]) -> datetime:
    raw = properties.get("time")
    if raw is None:
        raise ValueError("event missing properties.time")
    ts = float(raw)
    if ts > 1e12:
        ts = ts / 1000.0
    return datetime.fromtimestamp(ts, tz=timezone.utc)


def _synthesize_insert_id(event_name: str, properties: dict[str, Any]) -> str:
    distinct_id = _as_text(properties.get("distinct_id")) or ""
    time_value = properties.get("time")
    payload = json.dumps(
        {
            "event": event_name,
            "distinct_id": distinct_id,
            "time": time_value,
            "companyId": properties.get("companyId"),
            "userId": properties.get("userId") or properties.get("$user_id"),
        },
        sort_keys=True,
        default=str,
    )
    digest = hashlib.sha256(payload.encode("utf-8")).hexdigest()[:24]
    return f"syn_{digest}"


def parse_jsonl_line(line: str) -> EventRow:
    payload = json.loads(line)
    event_name = payload["event"]
    properties = dict(payload.get("properties") or {})
    raw_insert = properties.get("$insert_id")
    synthesized = not bool(raw_insert)
    insert_id = str(raw_insert) if raw_insert else _synthesize_insert_id(event_name, properties)
    user_id = _as_text(properties.get("$user_id")) or _as_text(properties.get("userId"))
    return EventRow(
        insert_id=insert_id,
        insert_id_synthesized=synthesized,
        event_name=event_name,
        event_time=_event_time(properties),
        distinct_id=_as_text(properties.get("distinct_id")) or "",
        user_id=user_id,
        uc_uuid=_as_text(properties.get("ucUuid")),
        email=_as_text(properties.get("email")),
        company_id=_as_text(properties.get("companyId")),
        company=_as_text(properties.get("company")),
        properties=properties,
    )


def parse_jsonl(text: str) -> tuple[list[EventRow], ParseStats]:
    rows: list[EventRow] = []
    synthesized = 0
    with_company = 0
    with_real = 0
    for line in text.splitlines():
        if not line.strip():
            continue
        row = parse_jsonl_line(line)
        rows.append(row)
        if row.insert_id_synthesized:
            synthesized += 1
        else:
            with_real += 1
        if row.company_id:
            with_company += 1
    stats = ParseStats(
        synthesized_insert_ids=synthesized,
        with_company_id=with_company,
        with_real_insert_id=with_real,
    )
    return rows, stats
