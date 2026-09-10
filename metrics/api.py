"""HTTP API for the retention heatmap (Worker B).

Reads the retention + explorer tables plus public.events; no export clients.
Start command: ``python -m metrics.api`` (binds 127.0.0.1:4830,
respects $PORT, default 4830).
"""

from __future__ import annotations

import json
import mimetypes
import os
import re
import statistics
import threading
from collections import Counter, defaultdict
from contextlib import contextmanager
from datetime import date, datetime, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlsplit
from zoneinfo import ZoneInfo

PROJECT_ROOT = Path(__file__).resolve().parent.parent
_UI_ROOT = PROJECT_ROOT / "ui-design"
WEB_ROOT = _UI_ROOT if (_UI_ROOT / "index.html").is_file() else PROJECT_ROOT / "web"
TIMEZONE = "Asia/Kolkata"
VALUE_EVENTS = ("Accounting Sync", "Recon Processed")
READY_EVENTS = ("Invoice Created", "Transaction Ledger Updated")
INTEGRATION_EVENT = "Integration status"
LEDGER_EVENTS = (
    "Transaction Ledger Updated",
    "Transaction Status",
    "Transaction Type Updated",
    "Transaction Configuration Edited",
    "Vendor Mismatch Resolved",
)
UPLOAD_TYPE_ORDER = (
    "invoice",
    "bill",
    "statement",
    "gstr2b",
    "purchase_register",
    "unknown",
)
PRODUCT_SPLIT_FLAGS = (
    ("had_bill_upload", "Bill"),
    ("had_invoice_upload", "Invoice"),
    ("had_statement_upload", "Statement"),
    ("had_ap_active", "AP"),
    ("had_txn_active", "Txn"),
    ("had_gst_recon", "GST"),
)
PRODUCT_SPLIT_KEYS = frozenset(key for key, _label in PRODUCT_SPLIT_FLAGS)

# Action set (activity/frequency). Mirrors metrics.refresh.ACTION_EVENTS;
# kept local (not imported) because refresh imports INTERNAL_EMAIL_DOMAINS
# from this module and a top-level import would be circular.
# Login, logout, Sign Up, Dashboard Viewed, Widget Clicked, Phone *,
# Company Created/Updated/Switched, Product Subscription, Billing Intent *
# are NOT actions and never appear in by_event counts.
ACTION_EVENTS = (
    "Upload",
    "Mapping Completed",
    "Saved Template Loaded",
    "Invoice Created",
    "Invoice Bulk Edited",
    "Download-Inv",
    "Preview",
    "Transaction Ledger Updated",
    "Transaction Status",
    "Transaction Type Updated",
    "Transaction Configuration Edited",
    "Vendor Mismatch Resolved",
    "Accounting Sync",
    "Recon Processed",
    "Entity Created",
    "Delete",
    "Download",
    "Export",
)

ACTION_FAMILIES = {
    "upload": ("Upload", "Mapping Completed", "Saved Template Loaded"),
    "ap": ("Invoice Created", "Invoice Bulk Edited", "Download-Inv", "Preview"),
    "txn": (
        "Transaction Ledger Updated",
        "Transaction Status",
        "Transaction Type Updated",
        "Transaction Configuration Edited",
        "Vendor Mismatch Resolved",
    ),
    "sync": ("Accounting Sync",),
    "recon": ("Recon Processed",),
    "other": ("Entity Created", "Delete", "Download", "Export"),
}

# The event chain is an explanatory view over existing raw events. It is
# deliberately separate from ACTION_EVENTS and the signed derived tables.
# Properties are allowlisted so the drawer exposes useful dimensions without
# leaking raw Mixpanel blobs or identity fields.
CHAIN_PROPERTY_KEYS = (
    "type",
    "subType",
    "status",
    "action",
    "source",
    "transactionType",
    "items_count",
    "entityType",
    "fileType",
    "productCode",
    "flow",
    "method",
)
CHAIN_BRANCH_ORDER = ("txn", "ap", "ar", "gst", "other")
CHAIN_BRANCH_LABELS = {
    "txn": "Txn",
    "ap": "AP",
    "ar": "AR",
    "gst": "GST",
    "other": "Other",
}
CHAIN_READY_EVENTS = {
    "txn": "Transaction Ledger Updated",
    "ap": "Invoice Created",
}
CHAIN_EVENT_NAMES = tuple(dict.fromkeys((
    "Sign Up",
    INTEGRATION_EVENT,
    *ACTION_EVENTS,
)))
CHAIN_EVENT_ORDER = (
    "Upload",
    "Mapping Completed",
    "Saved Template Loaded",
    "Entity Created",
    "Transaction Type Updated",
    "Transaction Configuration Edited",
    "Transaction Status",
    "Transaction Ledger Updated",
    "Vendor Mismatch Resolved",
    "Invoice Bulk Edited",
    "Download-Inv",
    "Preview",
    "Invoice Created",
    "Download",
    "Delete",
    "Export",
)

TIMELINE_DEFAULT_LIMIT = 100
TIMELINE_MAX_LIMIT = 500
CELL_COMPANY_LIMIT = 5000  # safety cap on members inside the cell CTE
BY_EVENT_LIMIT = 40  # max distinct action names in a company summary

_TABLE_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$")


def load_env() -> None:
    """Populate os.environ from .env without overriding existing vars."""
    try:
        from dotenv import load_dotenv

        load_dotenv(PROJECT_ROOT / ".env", override=False)
        return
    except ImportError:
        pass
    env_path = PROJECT_ROOT / ".env"
    if not env_path.exists():
        return
    for line in env_path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        if not key or key in os.environ:
            continue
        value = value.strip().strip("'").strip('"')
        os.environ[key] = value


def get_db_url() -> str:
    """TEST_DATABASE_URL overrides SUPABASE_DB_URL when set (tests)."""
    url = os.environ.get("TEST_DATABASE_URL") or os.environ.get("SUPABASE_DB_URL")
    if not url:
        raise RuntimeError("missing env SUPABASE_DB_URL (or TEST_DATABASE_URL)")
    return url


def get_events_table() -> str:
    """Events source table; default public.events (EVENTS_TABLE override)."""
    table = os.environ.get("EVENTS_TABLE", "public.events")
    if not _TABLE_RE.match(table):
        raise ValueError(f"refusing unsafe events table name: {table!r}")
    return table


INTERNAL_EMAIL_DOMAINS = frozenset({"karboncard.com", "korefi.ai"})


def is_internal_email(email: str | None) -> bool:
    """True for Karbon/Korefi staff mailboxes. Case-insensitive.

    Accepts bare addresses and ``Name <user@domain>``. Subdomains of
    the two staff domains count as internal too.
    """
    if not email:
        return False
    raw = email.strip().lower()
    if "<" in raw and ">" in raw:
        raw = raw[raw.rfind("<") + 1 : raw.rfind(">")].strip()
    if "@" not in raw:
        return False
    domain = raw.rsplit("@", 1)[1]
    if domain in INTERNAL_EMAIL_DOMAINS:
        return True
    return any(domain.endswith("." + d) for d in INTERNAL_EMAIL_DOMAINS)


def _iso(value):
    if value is None:
        return None
    if hasattr(value, "isoformat"):
        return value.isoformat()
    return str(value)


def _ttv_hours(signed_up_at, first_sync_at):
    """Hours from company signup to first sync; None when either is missing."""
    return _duration_hours(signed_up_at, first_sync_at)


def _duration_hours(start_at, end_at):
    """Return a non-negative, one-decimal duration in hours."""
    if start_at is None or end_at is None:
        return None
    try:
        seconds = (end_at - start_at).total_seconds()
        if seconds < 0:
            return None
        return round(seconds / 3600, 1)
    except Exception:
        return None


def _event_property(properties, key: str):
    if not isinstance(properties, dict):
        return None
    value = properties.get(key)
    if isinstance(value, str):
        value = value.strip()
        return value or None
    return value


def _upload_type(properties) -> str:
    value = _event_property(properties, "type")
    if value is None:
        return "unknown"
    return str(value).strip().lower() or "unknown"


def _is_failed_upload(properties) -> bool:
    value = _event_property(properties, "status")
    return isinstance(value, str) and value.lower() == "failed"


def _looks_like_uuid(value: str) -> bool:
    return bool(re.fullmatch(
        r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}",
        value,
        flags=re.IGNORECASE,
    ))


def _ist_now() -> datetime:
    return datetime.now(ZoneInfo(TIMEZONE))


def _chain_property_value(value):
    """Return a small display-safe scalar, or None for absent/blank values."""
    if value is None or isinstance(value, (dict, list, tuple, set)):
        return None
    if isinstance(value, bool):
        return "true" if value else "false"
    text = str(value).strip()
    return text or None


def _chain_branch(event_name: str, properties) -> str | None:
    """Classify a raw event for the explanatory product path.

    This is presentation classification only. It does not redefine Ready,
    activation, value, or any warehouse action family.
    """
    if event_name in {"Sign Up", INTEGRATION_EVENT,
                      "Accounting Sync", "Recon Processed"}:
        return None
    if event_name == "Upload":
        upload_type = _upload_type(properties)
        return {
            "statement": "txn",
            "bill": "ap",
            "invoice": "ar",
            "gstr2b": "gst",
            "purchase_register": "gst",
        }.get(upload_type, "other")
    if event_name == "Download":
        download_type = _event_property(properties, "type")
        download_type = (
            str(download_type).strip().lower()
            if download_type is not None else ""
        )
        return {
            "statement": "txn",
            "bill": "ap",
            "invoice": "ar",
            "reconciled_excel": "gst",
        }.get(download_type, "other")
    if event_name == "Export":
        export_type = _event_property(properties, "type")
        return "gst" if (
            export_type is not None
            and str(export_type).strip().lower() == "gst_reconciliation"
        ) else "other"
    if event_name in LEDGER_EVENTS:
        return "txn"
    if event_name in {
        "Invoice Created", "Invoice Bulk Edited", "Download-Inv", "Preview",
    }:
        return "ap"
    if event_name == "Entity Created":
        entity_type = _event_property(properties, "entityType")
        return "ap" if (
            entity_type is not None
            and str(entity_type).strip().lower() == "bill"
        ) else "other"
    if event_name in ACTION_EVENTS:
        return "other"
    return None


def _chain_role(event_name: str) -> str:
    if event_name == "Sign Up":
        return "entry"
    if event_name == INTEGRATION_EVENT:
        return "setup"
    if event_name == "Upload":
        return "entry"
    if event_name in READY_EVENTS:
        return "ready"
    if event_name == "Accounting Sync":
        return "activation"
    if event_name == "Recon Processed":
        return "value"
    return "supporting"


def _chain_event_node(event_name: str, rows, role: str | None = None) -> dict:
    ordered_rows = sorted(rows, key=lambda row: (row[0] is None, row[0]))
    property_counts = {
        key: Counter()
        for key in CHAIN_PROPERTY_KEYS
    }
    for _event_time, properties in ordered_rows:
        for key in CHAIN_PROPERTY_KEYS:
            value = _chain_property_value(_event_property(properties, key))
            if value is not None:
                property_counts[key][value] += 1
    properties = []
    for key in CHAIN_PROPERTY_KEYS:
        counts = property_counts[key]
        if not counts:
            continue
        properties.append({
            "key": key,
            "values": [
                {"value": value, "count": count}
                for value, count in sorted(
                    counts.items(), key=lambda item: (-item[1], item[0])
                )
            ],
        })
    return {
        "event_name": event_name,
        "role": role or _chain_role(event_name),
        "count": len(ordered_rows),
        "first_at": _iso(ordered_rows[0][0]) if ordered_rows else None,
        "last_at": _iso(ordered_rows[-1][0]) if ordered_rows else None,
        "properties": properties,
    }


def build_event_chain(rows, scope: str = "lifetime") -> dict:
    """Build the company product-event tree from (name, time, properties)."""
    setup_rows = defaultdict(list)
    branch_rows = defaultdict(lambda: defaultdict(list))
    sync_rows = []
    post_sync_rows = defaultdict(list)
    for event_name, event_time, properties in rows:
        if event_name in {"Sign Up", INTEGRATION_EVENT}:
            setup_rows[event_name].append((event_time, properties))
        elif event_name == "Accounting Sync":
            sync_rows.append((event_time, properties))
        elif event_name == "Recon Processed":
            post_sync_rows[event_name].append((event_time, properties))
        else:
            branch = _chain_branch(event_name, properties)
            if branch is not None:
                branch_rows[branch][event_name].append((event_time, properties))

    setup = [
        _chain_event_node(event_name, setup_rows[event_name])
        for event_name in ("Sign Up", INTEGRATION_EVENT)
        if setup_rows.get(event_name)
    ]
    order_index = {
        event_name: index for index, event_name in enumerate(CHAIN_EVENT_ORDER)
    }
    branches = []
    for branch_key in CHAIN_BRANCH_ORDER:
        events_for_branch = branch_rows.get(branch_key)
        if not events_for_branch:
            continue
        event_names = sorted(
            events_for_branch,
            key=lambda name: (
                order_index.get(name, len(order_index)),
                name,
            ),
        )
        nodes = [
            _chain_event_node(event_name, events_for_branch[event_name])
            for event_name in event_names
        ]
        ready_event = CHAIN_READY_EVENTS.get(branch_key)
        ready_count = (
            len(events_for_branch.get(ready_event, []))
            if ready_event else 0
        )
        branches.append({
            "key": branch_key,
            "label": CHAIN_BRANCH_LABELS[branch_key],
            "entry_event": "Upload" if events_for_branch.get("Upload") else None,
            "entry_count": len(events_for_branch.get("Upload", [])),
            "ready_event": ready_event,
            "ready_count": ready_count,
            "events": nodes,
        })
    post_sync = [
        _chain_event_node(event_name, post_sync_rows[event_name])
        for event_name in ("Recon Processed",)
        if post_sync_rows.get(event_name)
    ]
    return {
        "scope": scope,
        "setup": setup,
        "branches": branches,
        "sync": _chain_event_node("Accounting Sync", sync_rows)
        if sync_rows else None,
        "post_sync": post_sync,
    }


FEATURE_USAGE_MODULES = (
    {
        "key": "txn",
        "label": "Txn",
        "nodes": (
            ("upload_statement", "Statement upload"),
            ("ledger", "Transaction Ledger Updated"),
            ("type_updated", "Transaction Type Updated"),
            ("status", "Transaction Status"),
            ("sync", "Accounting Sync"),
        ),
    },
    {
        "key": "ap",
        "label": "AP",
        "nodes": (
            ("upload_bill", "Bill upload"),
            ("entity_bill", "Entity Created"),
            ("invoice_created", "Invoice Created"),
            ("invoice_bulk", "Invoice Bulk Edited"),
            ("preview", "Preview"),
            ("download_inv", "Download-Inv"),
            ("sync", "Accounting Sync"),
        ),
    },
    {
        "key": "ar",
        "label": "AR",
        "nodes": (
            ("upload_invoice", "Invoice upload"),
            ("sync", "Accounting Sync"),
        ),
        "note": "Warehouse has invoice uploads. AR work events are not defined yet.",
    },
    {
        "key": "gst",
        "label": "GST",
        "nodes": (
            ("upload_gst", "GST upload"),
            ("download_recon", "Download reconciled"),
            ("export", "Export"),
            ("recon", "Recon Processed"),
        ),
    },
)
FEATURE_SLICE_KEYS = frozenset(
    {module["key"] for module in FEATURE_USAGE_MODULES}
    | {
        f"{module['key']}.{node_key}"
        for module in FEATURE_USAGE_MODULES
        for node_key, _label in module["nodes"]
    }
)

# Overview uses these definitions for a product-level map. They are kept
# separate from the signed ACTION_EVENTS and company_week_product flags. The
# map is an explanatory view over raw events, not a replacement for Retention.
MODULE_USAGE_DEFINITIONS = (
    {
        "key": "txn",
        "label": "Txn",
        "entry": "upload_statement",
        "endpoint": "sync",
        "nodes": (
            ("upload_statement", "Statement upload"),
            ("ledger", "Transaction Ledger Updated"),
            ("type_updated", "Transaction Type Updated"),
            ("status", "Transaction Status"),
            ("configuration", "Transaction Configuration Edited"),
            ("vendor_mismatch", "Vendor Mismatch Resolved"),
            ("sync", "Accounting Sync"),
        ),
    },
    {
        "key": "ap",
        "label": "AP",
        "entry": "upload_bill",
        "endpoint": "sync",
        "nodes": (
            ("upload_bill", "Bill upload"),
            ("entity_bill", "Entity Created"),
            ("invoice_created", "Invoice Created"),
            ("invoice_bulk", "Invoice Bulk Edited"),
            ("preview", "Preview"),
            ("download_inv", "Download-Inv"),
            ("sync", "Accounting Sync"),
        ),
    },
    {
        "key": "ar",
        "label": "AR",
        "entry": "upload_invoice",
        "endpoint": "sync",
        "note": "Invoice uploads are tracked. AR work events are not defined yet.",
        "nodes": (
            ("upload_invoice", "Invoice upload"),
            ("sync", "Accounting Sync"),
        ),
    },
    {
        "key": "gst",
        "label": "GST",
        "entry": "upload_gst",
        "endpoint": "recon",
        "nodes": (
            ("upload_gst", "GST upload"),
            ("download_recon", "Download reconciled"),
            ("export", "Export"),
            ("recon", "Recon Processed"),
        ),
    },
)


def _module_upload_node(event_type: str) -> str | None:
    return {
        "statement": "txn.upload_statement",
        "bill": "ap.upload_bill",
        "invoice": "ar.upload_invoice",
        "gstr2b": "gst.upload_gst",
        "gst2b": "gst.upload_gst",
        "purchase_register": "gst.upload_gst",
    }.get(event_type)


def _module_node_for_event(event_name: str, properties) -> str | None:
    """Classify one raw event into the Overview module map."""
    event_type = _upload_type(properties)
    if event_name == "Upload" and not _is_failed_upload(properties):
        return _module_upload_node(event_type)
    if event_name == "Transaction Ledger Updated":
        return "txn.ledger"
    if event_name == "Transaction Type Updated":
        return "txn.type_updated"
    if event_name == "Transaction Status":
        return "txn.status"
    if event_name == "Transaction Configuration Edited":
        return "txn.configuration"
    if event_name == "Vendor Mismatch Resolved":
        return "txn.vendor_mismatch"
    if event_name == "Entity Created":
        return "ap.entity_bill" if str(_event_property(properties, "entityType") or "").strip().lower() == "bill" else None
    if event_name == "Invoice Created":
        return "ap.invoice_created"
    if event_name == "Invoice Bulk Edited":
        return "ap.invoice_bulk"
    if event_name == "Preview":
        return "ap.preview"
    if event_name == "Download-Inv":
        return "ap.download_inv"
    if event_name == "Download" and event_type == "reconciled_excel":
        return "gst.download_recon"
    if event_name == "Export" and event_type == "gst_reconciliation":
        return "gst.export"
    if event_name == "Accounting Sync":
        return "sync"
    if event_name == "Recon Processed":
        return "gst.recon"
    return None


def _module_definition(module_key: str):
    return next((item for item in MODULE_USAGE_DEFINITIONS if item["key"] == module_key), None)


def _module_property_value(properties, key: str):
    value = _event_property(properties, key)
    if value is None:
        return None
    if key == "type":
        normalized = str(value).strip().lower()
        return "gstr2b" if normalized == "gst2b" else normalized or None
    return _chain_property_value(value)


def _module_breakdown(rows) -> list[dict]:
    """Return flat counts for the allowlisted event properties."""
    buckets = defaultdict(lambda: {"events": 0, "companies": set()})
    for company_id, _distinct_id, _email, _event_name, _event_time, properties, _node in rows:
        for key in CHAIN_PROPERTY_KEYS:
            value = _module_property_value(properties, key)
            if value is None:
                continue
            bucket = buckets[(key, value)]
            bucket["events"] += 1
            bucket["companies"].add(str(company_id))
    result = [
        {
            "key": key,
            "label": key,
            "value": value,
            "count": int(bucket["events"]),
            "events": int(bucket["events"]),
            "companies": len(bucket["companies"]),
        }
        for (key, value), bucket in buckets.items()
    ]
    result.sort(key=lambda item: (-item["events"], item["key"], str(item["value"])))
    return result


def _module_usage_payload(
    cur, events_table: str, start: date, end: date,
    granularity: str | None = None,
) -> dict:
    """Return company-level module reach for one IST window.

    Stage counts are reach counts, not forced conversion counts. The endpoint
    stage additionally reports companies whose endpoint occurred after the
    module entry, so the Overview can show a truthful entry-to-endpoint rate.
    """
    cur.execute(
        f"""
        SELECT e.company_id, e.distinct_id, e.email, e.event_name,
               e.event_time, e.properties
        FROM {events_table} e
        WHERE e.event_name = ANY(%(events)s)
          AND EXISTS (
            SELECT 1 FROM client_company c WHERE c.company_id = e.company_id
          )
          AND e.event_time >= (%(start)s::date::timestamp AT TIME ZONE '{TIMEZONE}')
          AND e.event_time < (%(end)s::date::timestamp AT TIME ZONE '{TIMEZONE}')
        ORDER BY e.company_id, e.event_time ASC, e.insert_id ASC
        """,
        {
            "events": list(ACTION_EVENTS),
            "start": start,
            "end": end,
        },
    )
    company_events: dict[str, list[tuple]] = defaultdict(list)
    active_companies: set[str] = set()
    active_people: set[str] = set()
    for company_id, distinct_id, email, event_name, event_time, properties in cur.fetchall():
        company = str(company_id)
        name = str(event_name)
        active_companies.add(company)
        if distinct_id and not is_internal_email(email):
            active_people.add(str(distinct_id))
        company_events[company].append(
            (company, distinct_id, email, name, event_time, properties,
             _module_node_for_event(name, properties))
        )

    module_payload = []
    for definition in MODULE_USAGE_DEFINITIONS:
        module_key = definition["key"]
        entry_node = f"{module_key}.{definition['entry']}"
        endpoint_node = f"{module_key}.{definition['endpoint']}"
        stats = {
            node_key: {
                "companies": set(),
                "events": 0,
                "failed_events": 0,
                "event_names": set(),
                "properties": defaultdict(lambda: defaultdict(lambda: {"events": 0, "companies": set()})),
            }
            for node_key, _label in definition["nodes"]
        }
        module_companies: set[str] = set()
        entry_times: dict[str, datetime] = {}
        endpoint_after_entry: set[str] = set()
        endpoint_events = 0
        endpoint_event_names: set[str] = set()
        endpoint_properties = defaultdict(lambda: defaultdict(lambda: {"events": 0, "companies": set()}))

        for company, rows in company_events.items():
            for _company, _distinct_id, _email, event_name, event_time, properties, node_key in rows:
                if event_name == "Upload" and _is_failed_upload(properties):
                    failed_node = _module_upload_node(_upload_type(properties))
                    if failed_node and failed_node.startswith(f"{module_key}."):
                        stats[failed_node.split(".", 1)[1]]["failed_events"] += 1
                    continue
                if node_key == entry_node:
                    previous = entry_times.get(company)
                    if previous is None or event_time < previous:
                        entry_times[company] = event_time

        for company, rows in company_events.items():
            entry_time = entry_times.get(company)
            if entry_time is None:
                continue
            for _company, _distinct_id, _email, event_name, event_time, properties, node_key in rows:
                if event_name == "Upload" and _is_failed_upload(properties):
                    continue
                is_endpoint = (
                    node_key == endpoint_node
                    or (definition["endpoint"] == "sync" and node_key == "sync")
                )
                if node_key == "sync" and definition["endpoint"] != "sync":
                    continue
                node_module, node = node_key.split(".", 1) if node_key and "." in node_key else (None, None)
                stat_node = definition["endpoint"] if node_key == "sync" else node
                if event_time < entry_time or (
                    node_key != "sync" and node_module != module_key
                ):
                    continue
                if not node_key or stat_node not in stats:
                    continue
                module_companies.add(company)
                target = stats[stat_node]["properties"]
                if is_endpoint:
                    endpoint_after_entry.add(company)
                    endpoint_events += 1
                    endpoint_event_names.add(event_name)
                stats[stat_node]["companies"].add(company)
                stats[stat_node]["events"] += 1
                stats[stat_node]["event_names"].add(event_name)
                for prop_key in CHAIN_PROPERTY_KEYS:
                    prop_value = _module_property_value(properties, prop_key)
                    if prop_value is None:
                        continue
                    bucket = target[prop_key][prop_value]
                    bucket["events"] += 1
                    bucket["companies"].add(company)

        entry_count = len(stats[definition["entry"]]["companies"])

        def properties_payload(source):
            result = []
            for prop_key, values in source.items():
                rows = [
                    {
                        "value": value,
                        "events": int(item["events"]),
                        "companies": len(item["companies"]),
                    }
                    for value, item in values.items()
                ]
                rows.sort(key=lambda item: (-item["events"], item["value"]))
                if rows:
                    result.append({"key": prop_key, "values": rows[:8]})
            result.sort(key=lambda item: item["key"])
            return result

        def event_names_payload(source):
            return sorted(source)

        stages = []
        for node_key, label in definition["nodes"]:
            full_key = f"{module_key}.{node_key}"
            stage_rows = []
            for company, rows in company_events.items():
                entry_time = entry_times.get(company)
                if entry_time is None:
                    continue
                for row in rows:
                    _company, _distinct_id, _email, event_name, event_time, properties, row_node = row
                    is_endpoint = (
                        row_node == endpoint_node
                        or (definition["endpoint"] == "sync" and row_node == "sync")
                    )
                    if event_time >= entry_time and (
                        row_node == full_key or (node_key == definition["endpoint"] and is_endpoint)
                    ) and not (event_name == "Upload" and _is_failed_upload(properties)):
                        stage_rows.append(row)
            item = stats[node_key]
            companies = len({row[0] for row in stage_rows})
            events = len(stage_rows)
            property_breakdown = _module_breakdown(stage_rows)
            properties = properties_payload(item["properties"])
            event_name_counts = Counter(row[3] for row in stage_rows)
            event_names = [
                {"event_name": name, "count": int(count)}
                for name, count in sorted(event_name_counts.items())
            ]
            people = len({
                str(row[1]) for row in stage_rows
                if row[1] and not is_internal_email(row[2])
            })
            first_at = min((row[4] for row in stage_rows), default=None)
            last_at = max((row[4] for row in stage_rows), default=None)
            failed_events = item["failed_events"]
            previous_reached = stages[-1]["reached"] if stages else None
            conversion = (
                round(companies / previous_reached, 4)
                if previous_reached else (1.0 if companies else 0.0)
            )
            stages.append({
                "key": node_key,
                "label": label,
                "companies": companies,
                "events": events,
                "people": people,
                "reached": companies,
                "reach": companies,
                "previous_reached": previous_reached,
                "dropped": max(previous_reached - companies, 0) if previous_reached is not None else 0,
                "conversion_rate": conversion,
                "conversion": conversion,
                "conversion_from_entry": round(companies / entry_count, 4) if entry_count else None,
                "first_at": _iso(first_at),
                "last_at": _iso(last_at),
                "properties": properties,
                "breakdown": property_breakdown,
                "property_breakdown": property_breakdown,
                "event_names": event_names,
                "failed_events": failed_events,
                "types": [
                    {
                        "value": item["value"],
                        "events": item["events"],
                        "companies": item["companies"],
                    }
                    for item in property_breakdown if item["key"] == "type"
                ],
                "endpoint": node_key == definition["endpoint"],
            })
        module_payload.append({
            "key": module_key,
            "label": definition["label"],
            "window_start": start.isoformat(),
            "window_end": end.isoformat(),
            "granularity": "week" if (end - start).days == 7 else "month",
            "note": definition.get("note"),
            "companies": len(module_companies),
            "people": len({
                str(event_row[1]) for company_rows in company_events.values()
                for event_row in company_rows
                if event_row[0] in module_companies
                and event_row[1]
                and not is_internal_email(event_row[2])
                and (
                    event_row[6] == "sync"
                    or (
                        event_row[6]
                        and event_row[6].startswith(f"{module_key}.")
                    )
                )
            }),
            "active_companies": len(module_companies),
            "active_people": len(active_people),
            "module_companies": len(module_companies),
            "entry_companies": entry_count,
            "endpoint_companies": len(endpoint_after_entry),
            "conversion": round(len(endpoint_after_entry) / entry_count, 4) if entry_count else None,
            "entry_key": definition["entry"],
            "endpoint_key": definition["endpoint"],
            "property_breakdown": _module_breakdown([
                event_row for company_rows in company_events.values()
                for event_row in company_rows
                if event_row[0] in module_companies
                and event_row[4] >= entry_times.get(event_row[0], event_row[4])
                and not (event_row[3] == "Upload" and _is_failed_upload(event_row[5]))
                and (
                    event_row[6] == "sync"
                    or (
                        event_row[6]
                        and event_row[6].startswith(f"{module_key}.")
                    )
                )
            ]),
            "stages": stages,
        })
    return {
        "scope": "period",
        "period_start": start.isoformat(),
        "period_end": end.isoformat(),
        "granularity": "week" if (end - start).days == 7 else "month",
        "active_companies": len(active_companies),
        "active_people": len(active_people),
        "modules": module_payload,
    }


def _event_type_sql(alias: str = "e") -> str:
    return (
        "CASE"
        f" WHEN lower(btrim(COALESCE({alias}.properties->>'type', '')))"
        " = 'gst2b' THEN 'gstr2b'"
        f" ELSE NULLIF(lower(btrim({alias}.properties->>'type')), '')"
        " END"
    )


def _week_event_sql(events_table: str) -> str:
    return (
        f" FROM {events_table} e"
        " WHERE EXISTS ("
        " SELECT 1 FROM client_company c WHERE c.company_id = e.company_id"
        ")"
        f" AND e.event_time >= (%(week)s::date AT TIME ZONE '{TIMEZONE}')"
        f" AND e.event_time < ((%(week)s::date + 7) AT TIME ZONE '{TIMEZONE}')"
    )


def _feature_node_predicate(node_key: str, alias: str = "e") -> str:
    type_sql = _event_type_sql(alias)
    upload_ok = (
        f"{alias}.event_name = 'Upload'"
        f" AND {alias}.properties->>'status' IS DISTINCT FROM 'Failed'"
    )
    predicates = {
        "txn.upload_statement": f"{upload_ok} AND {type_sql} = 'statement'",
        "txn.ledger": f"{alias}.event_name = 'Transaction Ledger Updated'",
        "txn.type_updated": f"{alias}.event_name = 'Transaction Type Updated'",
        "txn.status": f"{alias}.event_name = 'Transaction Status'",
        "ap.upload_bill": f"{upload_ok} AND {type_sql} = 'bill'",
        "ap.entity_bill": (
            f"{alias}.event_name = 'Entity Created'"
            f" AND lower(btrim(COALESCE({alias}.properties->>'entityType', '')))"
            " = 'bill'"
        ),
        "ap.invoice_created": f"{alias}.event_name = 'Invoice Created'",
        "ap.invoice_bulk": f"{alias}.event_name = 'Invoice Bulk Edited'",
        "ap.preview": f"{alias}.event_name = 'Preview'",
        "ap.download_inv": f"{alias}.event_name = 'Download-Inv'",
        "ar.upload_invoice": f"{upload_ok} AND {type_sql} = 'invoice'",
        "gst.upload_gst": (
            f"{upload_ok} AND {type_sql} IN ('gstr2b', 'purchase_register')"
        ),
        "gst.download_recon": (
            f"{alias}.event_name = 'Download'"
            f" AND {type_sql} = 'reconciled_excel'"
        ),
        "gst.export": (
            f"{alias}.event_name = 'Export'"
            f" AND {type_sql} = 'gst_reconciliation'"
        ),
        "gst.recon": f"{alias}.event_name = 'Recon Processed'",
    }
    if node_key in predicates:
        return predicates[node_key]
    raise ValueError(f"invalid feature key {node_key}")


def _feature_path_predicate(module_key: str, alias: str = "e") -> str:
    nodes = {
        "txn": (
            "txn.upload_statement", "txn.ledger", "txn.type_updated",
            "txn.status",
        ),
        "ap": (
            "ap.upload_bill", "ap.entity_bill", "ap.invoice_created",
            "ap.invoice_bulk", "ap.preview", "ap.download_inv",
        ),
        "ar": ("ar.upload_invoice",),
        "gst": (
            "gst.upload_gst", "gst.download_recon", "gst.export", "gst.recon",
        ),
    }
    if module_key not in nodes:
        raise ValueError(f"invalid feature key {module_key}")
    parts = [_feature_node_predicate(node, alias) for node in nodes[module_key]]
    return "(" + " OR ".join(parts) + ")"


def _feature_slice_predicate(key: str, alias: str = "e",
                             events_table: str = "public.events") -> str:
    if "." not in key:
        return _feature_path_predicate(key, alias)
    module_key, node_key = key.split(".", 1)
    if node_key == "sync":
        return (
            f"{alias}.event_name = 'Accounting Sync'"
            f" AND EXISTS ("
            f" SELECT 1 FROM {events_table} pe"
            f" WHERE pe.company_id = {alias}.company_id"
            f" AND pe.event_time >= (%(week)s::date AT TIME ZONE '{TIMEZONE}')"
            f" AND pe.event_time < ((%(week)s::date + 7) AT TIME ZONE '{TIMEZONE}')"
            f" AND {_feature_path_predicate(module_key, 'pe')}"
            ")"
        )
    return _feature_node_predicate(key, alias)


def _empty_feature_usage(week: date) -> dict:
    modules = []
    for module in FEATURE_USAGE_MODULES:
        modules.append({
            "key": module["key"],
            "label": module["label"],
            "companies": 0,
            "note": module.get("note"),
            "nodes": [
                {
                    "key": node_key,
                    "label": label,
                    "companies": 0,
                    "events": 0,
                    "types": [],
                }
                for node_key, label in module["nodes"]
            ],
        })
    return {"week_start": week.isoformat(), "modules": modules}


def _feature_usage_payload(cur, events_table: str, week: date) -> dict:
    """Selected-week module chain. Company counts, not people."""
    type_sql = _event_type_sql("e")
    week_sql = _week_event_sql(events_table)
    node_cases = []
    for module in FEATURE_USAGE_MODULES:
        for node_key, _label in module["nodes"]:
            full = f"{module['key']}.{node_key}"
            if node_key == "sync":
                continue
            node_cases.append(
                f" WHEN {_feature_node_predicate(full)} THEN '{full}'"
            )
    cur.execute(
        "SELECT"
        " CASE"
        + "".join(node_cases)
        + " END AS node_key,"
        f" {type_sql} AS type_value,"
        " COUNT(*)::int,"
        " COUNT(DISTINCT e.company_id)::int"
        f"{week_sql}"
        " AND ("
        + " OR ".join(
            _feature_node_predicate(f"{module['key']}.{node_key}")
            for module in FEATURE_USAGE_MODULES
            for node_key, _label in module["nodes"]
            if node_key != "sync"
        )
        + ")"
        " GROUP BY 1, 2",
        {"week": week},
    )
    type_rows: dict[str, list] = {}
    for node_key, type_value, events, companies in cur.fetchall():
        if not node_key:
            continue
        type_rows.setdefault(node_key, []).append(
            (type_value, int(events or 0), int(companies or 0))
        )
    node_stats: dict[str, dict] = {}
    for node_key, rows in type_rows.items():
        node_stats[node_key] = {
            "events": sum(item[1] for item in rows),
            "companies": 0,
            "types": [
                {
                    "value": str(type_value),
                    "events": events,
                    "companies": companies,
                }
                for type_value, events, companies in sorted(
                    rows, key=lambda item: (-item[1], str(item[0] or ""))
                )
                if type_value
            ],
        }
    path_pred = " OR ".join(
        _feature_node_predicate(f"{module['key']}.{node_key}")
        for module in FEATURE_USAGE_MODULES
        for node_key, _label in module["nodes"]
        if node_key != "sync"
    )
    cur.execute(
        "SELECT"
        " CASE"
        + "".join(node_cases)
        + " END AS node_key,"
        " COUNT(DISTINCT e.company_id)::int"
        f"{week_sql}"
        f" AND ({path_pred})"
        " GROUP BY 1",
        {"week": week},
    )
    for node_key, companies in cur.fetchall():
        if not node_key:
            continue
        node_stats.setdefault(node_key, {"events": 0, "companies": 0, "types": []})
        node_stats[node_key]["companies"] = int(companies or 0)

    path_ids: dict[str, set[str]] = {module["key"]: set() for module in FEATURE_USAGE_MODULES}
    for module in FEATURE_USAGE_MODULES:
        cur.execute(
            "SELECT DISTINCT e.company_id"
            f"{week_sql}"
            f" AND {_feature_path_predicate(module['key'])}",
            {"week": week},
        )
        path_ids[module["key"]] = {str(row[0]) for row in cur.fetchall()}

    cur.execute(
        "SELECT DISTINCT e.company_id"
        f"{week_sql}"
        " AND e.event_name = 'Accounting Sync'",
        {"week": week},
    )
    sync_ids = {str(row[0]) for row in cur.fetchall()}

    payload = _empty_feature_usage(week)
    for module in payload["modules"]:
        module_key = module["key"]
        path = path_ids[module_key]
        module["companies"] = len(path)
        for node in module["nodes"]:
            full = f"{module_key}.{node['key']}"
            if node["key"] == "sync":
                synced = path & sync_ids
                node["companies"] = len(synced)
                node["events"] = 0
                node["types"] = []
                if synced:
                    cur.execute(
                        "SELECT COUNT(*)::int"
                        f"{week_sql}"
                        " AND e.event_name = 'Accounting Sync'"
                        " AND e.company_id = ANY(%(ids)s)",
                        {"week": week, "ids": list(synced)},
                    )
                    node["events"] = int(cur.fetchone()[0] or 0)
                    cur.execute(
                        "SELECT"
                        f" {type_sql},"
                        " COUNT(*)::int,"
                        " COUNT(DISTINCT e.company_id)::int"
                        f"{week_sql}"
                        " AND e.event_name = 'Accounting Sync'"
                        " AND e.company_id = ANY(%(ids)s)"
                        f" AND {type_sql} IS NOT NULL"
                        " GROUP BY 1"
                        " ORDER BY 2 DESC",
                        {"week": week, "ids": list(synced)},
                    )
                    node["types"] = [
                        {
                            "value": str(value),
                            "events": int(events or 0),
                            "companies": int(companies or 0),
                        }
                        for value, events, companies in cur.fetchall()
                    ]
                continue
            stats = node_stats.get(full, {"events": 0, "companies": 0, "types": []})
            node["events"] = stats["events"]
            node["companies"] = stats["companies"]
            node["types"] = sorted(
                stats["types"], key=lambda item: (-item["events"], item["value"])
            )
    return payload


def _ist_monday() -> date:
    now = _ist_now()
    return now.date() - timedelta(days=now.weekday())


def _add_months(value: date, months: int) -> date:
    """Return the first day of a shifted month (all callers use month starts)."""
    ordinal = value.year * 12 + (value.month - 1) + months
    return date(ordinal // 12, ordinal % 12 + 1, 1)


def _overview_period(query: str) -> dict[str, date | str | bool]:
    """Resolve the Overview's week/month control in IST."""
    params = parse_qs(query, keep_blank_values=True)
    mode = (params.get("period") or ["month"])[0]
    if mode not in {"week", "month"}:
        raise ValueError("period must be week or month")
    today = _ist_now().date()
    current_week = today - timedelta(days=today.weekday())
    current_month = today.replace(day=1)
    raw_anchor = (params.get("anchor") or [None])[0]
    if mode == "week":
        start = _exact_date(raw_anchor, "anchor", monday=True) if raw_anchor else current_week
        end = start + timedelta(days=7)
        previous_start = start - timedelta(days=7)
    else:
        start = _exact_date(raw_anchor, "anchor", month_start=True) if raw_anchor else current_month
        end = _add_months(start, 1)
        previous_start = _add_months(start, -1)
    return {
        "mode": mode,
        "start": start,
        "end": end,
        "previous_start": previous_start,
        "previous_end": start,
        "current": start == (current_week if mode == "week" else current_month),
    }


def _overview_window_counts(cur, events_table: str, start: date, end: date) -> dict:
    cur.execute(
        f"""
        SELECT
          COUNT(DISTINCT e.distinct_id) FILTER (
            WHERE NOT public.is_internal_email(e.email)
          )::int AS people,
          COUNT(DISTINCT e.company_id)::int AS companies
        FROM {events_table} e
        WHERE e.event_name = ANY(%(actions)s)
          AND EXISTS (
            SELECT 1 FROM client_company c WHERE c.company_id = e.company_id
          )
          AND e.event_time >= (%(start)s::date::timestamp AT TIME ZONE '{TIMEZONE}')
          AND e.event_time < (%(end)s::date::timestamp AT TIME ZONE '{TIMEZONE}')
        """,
        {"actions": list(ACTION_EVENTS), "start": start, "end": end},
    )
    people, companies = cur.fetchone()
    return {"people": int(people or 0), "companies": int(companies or 0)}


def _overview_adoption(cur, events_table: str, start: date, end: date) -> dict:
    """Company cohort journey for one selected IST week or month."""
    cur.execute(
        f"""
        WITH clocks AS (
          SELECT c.company_id,
                 COALESCE(
                   MIN(e.event_time) FILTER (WHERE e.event_name = 'Company Created'),
                   MIN(e.event_time)
                 ) AS first_seen_at,
                 MIN(e.event_time) FILTER (WHERE e.event_name = '{INTEGRATION_EVENT}') AS integration_at,
                 MIN(e.event_time) FILTER (WHERE e.event_name = 'Accounting Sync') AS sync_at,
                 MIN(e.event_time) FILTER (WHERE e.event_name = ANY(%(actions)s)) AS action_at
          FROM client_company c
          LEFT JOIN {events_table} e ON e.company_id = c.company_id
          GROUP BY c.company_id
        ), cohort AS (
          SELECT * FROM clocks
          WHERE first_seen_at >= (%(start)s::date::timestamp AT TIME ZONE '{TIMEZONE}')
            AND first_seen_at < (%(end)s::date::timestamp AT TIME ZONE '{TIMEZONE}')
        )
        SELECT
          COUNT(*)::int AS new_companies,
          COUNT(*) FILTER (
            WHERE integration_at IS NOT NULL
              AND integration_at >= first_seen_at
          )::int AS integrated,
          COUNT(*) FILTER (
            WHERE EXISTS (
              SELECT 1 FROM {events_table} upload_event
              WHERE upload_event.company_id = cohort.company_id
                AND upload_event.event_name = 'Upload'
                AND upload_event.event_time >= first_seen_at
            )
          )::int AS uploaded,
          COUNT(*) FILTER (
            WHERE EXISTS (
              SELECT 1 FROM {events_table} ready_event
              WHERE ready_event.company_id = cohort.company_id
                AND ready_event.event_name = ANY(%(ready)s)
                AND ready_event.event_time >= first_seen_at
            )
          )::int AS ready,
          COUNT(*) FILTER (
            WHERE sync_at IS NOT NULL
              AND sync_at >= first_seen_at
          )::int AS activated,
          COUNT(*) FILTER (
            WHERE sync_at IS NOT NULL
              AND sync_at >= first_seen_at
              AND EXISTS (
                SELECT 1 FROM {events_table} active_event
                WHERE active_event.company_id = cohort.company_id
                  AND active_event.event_name = ANY(%(actions)s)
                  AND active_event.event_time >= (%(start)s::date::timestamp AT TIME ZONE '{TIMEZONE}')
                  AND active_event.event_time < (%(end)s::date::timestamp AT TIME ZONE '{TIMEZONE}')
                  AND active_event.event_time >= sync_at
              )
          )::int AS active
        FROM cohort
        """,
        {
            "actions": list(ACTION_EVENTS),
            "ready": list(READY_EVENTS),
            "start": start,
            "end": end,
        },
    )
    new_companies, integrated, uploaded, ready, activated, active = cur.fetchone()
    cur.execute(
        f"""
        WITH clocks AS (
          SELECT c.company_id,
                 COALESCE(
                   MIN(e.event_time) FILTER (WHERE e.event_name = 'Company Created'),
                   MIN(e.event_time)
                 ) AS first_seen_at,
                 MIN(e.event_time) FILTER (WHERE e.event_name = '{INTEGRATION_EVENT}') AS integration_at,
                 MIN(e.event_time) FILTER (WHERE e.event_name = 'Accounting Sync') AS sync_at
          FROM client_company c
          LEFT JOIN {events_table} e ON e.company_id = c.company_id
          GROUP BY c.company_id
        ), cohort AS (
          SELECT * FROM clocks
          WHERE first_seen_at >= (%(start)s::date::timestamp AT TIME ZONE '{TIMEZONE}')
            AND first_seen_at < (%(end)s::date::timestamp AT TIME ZONE '{TIMEZONE}')
            AND sync_at IS NOT NULL
            AND sync_at >= first_seen_at
        )
        SELECT COUNT(DISTINCT e.distinct_id)::int
        FROM {events_table} e
        JOIN cohort c ON c.company_id = e.company_id
        WHERE e.event_name = ANY(%(actions)s)
          AND e.distinct_id IS NOT NULL
          AND NOT public.is_internal_email(e.email)
          AND e.event_time >= (%(start)s::date::timestamp AT TIME ZONE '{TIMEZONE}')
          AND e.event_time < (%(end)s::date::timestamp AT TIME ZONE '{TIMEZONE}')
          AND e.event_time >= c.sync_at
        """,
        {"actions": list(ACTION_EVENTS), "start": start, "end": end},
    )
    active_people = int((cur.fetchone() or (0,))[0] or 0)
    rows = [
        ("signup", "Signup", new_companies),
        ("integration", "Integration status", integrated),
        ("upload", "Upload", uploaded),
        ("ready", "Ready", ready),
        ("sync", "First Accounting Sync", activated),
        ("active", "Active after sync", active),
    ]
    base = int(new_companies or 0)
    stages = []
    for key, label, count in rows:
        reached = int(count or 0)
        previous = stages[-1]["reached"] if stages else None
        conversion = (
            round(reached / previous, 4)
            if previous else (1.0 if reached else 0.0)
        )
        stages.append({
            "key": key,
            "label": label,
            "companies": reached,
            "reached": reached,
            "reach": reached,
            "previous_reached": previous,
            "dropped": max(previous - reached, 0) if previous is not None else 0,
            "conversion_rate": conversion,
            "conversion": conversion,
            "conversion_from_new": round(reached / base, 4) if base else None,
            "window_start": start.isoformat(),
            "window_end": end.isoformat(),
        })
    story = []
    for stage in (stages[0], stages[1], stages[4], stages[5]):
        previous = story[-1]["reached"] if story else None
        reached = stage["reached"]
        conversion = (
            round(reached / previous, 4)
            if previous else (1.0 if reached else 0.0)
        )
        story.append({
            **stage,
            "previous_reached": previous,
            "dropped": max(previous - reached, 0) if previous is not None else 0,
            "conversion_rate": conversion,
            "conversion": conversion,
        })
    return {
        "key": "week" if (end - start).days == 7 else "month",
        "label": "Selected week" if (end - start).days == 7 else "Selected month",
        "granularity": "week" if (end - start).days == 7 else "month",
        "start": start.isoformat(),
        "end": end.isoformat(),
        "window_start": start.isoformat(),
        "window_end": end.isoformat(),
        "cohort_size": base,
        "new_companies": base,
        "active_people": active_people,
        "active_companies": int(active or 0),
        "funnel": stages,
        "stages": stages,
        "journey": story,
    }


def _exact_date(raw: str | None, name: str, *, monday: bool = False,
                month_start: bool = False) -> date:
    if raw is None or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", raw):
        raise ValueError(f"{name} must be YYYY-MM-DD")
    try:
        parsed = date.fromisoformat(raw)
    except ValueError as exc:
        raise ValueError(f"{name} must be YYYY-MM-DD") from exc
    if monday and parsed.weekday() != 0:
        raise ValueError(f"{name} must be a Monday")
    if month_start and parsed.day != 1:
        raise ValueError(f"{name} must be YYYY-MM-01")
    return parsed


def _parse_week_filter(query: str) -> tuple[date | None, date | None]:
    """Parse optional activation-week bounds and snap them to IST Mondays."""
    params = parse_qs(query, keep_blank_values=True)
    bounds: dict[str, date | None] = {}
    for name in ("from_week", "to_week"):
        raw = (params.get(name) or [None])[0]
        if raw is None:
            bounds[name] = None
            continue
        if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", raw):
            raise ValueError(f"{name} must be YYYY-MM-DD")
        try:
            parsed = date.fromisoformat(raw)
        except ValueError as exc:
            raise ValueError(f"{name} must be YYYY-MM-DD") from exc
        bounds[name] = parsed - timedelta(days=parsed.weekday())

    from_week = bounds["from_week"]
    to_week = bounds["to_week"]
    if from_week is not None and to_week is not None and from_week > to_week:
        raise ValueError("from_week must be on or before to_week")
    return from_week, to_week


def _per_week(lifetime_actions: int, active_weeks: int) -> float:
    if not active_weeks:
        return 0.0
    return round(lifetime_actions / active_weeks, 1)


# One database round trip for the whole cell: members (activation_week W
# AND a value event in week W+rel) joined to company_profile,
# company_week_action at the target week, per-(company, distinct_id)
# people aggregates, and the distinct value-event names at the target
# week. Python then nests companies under users from these same rows.
_CELL_SQL = """
WITH members AS (
  SELECT a.company_id, a.activated_at, a.activation_week,
         p.company_name, p.signed_up_at, p.first_sync_at,
         p.last_action_at, p.action_count, p.active_weeks,
         p.path_had_upload, p.path_had_ready,
         p.path_had_sync, p.path_had_recon,
         COALESCE(w.action_count, 0) AS atw,
         COALESCE(w.upload_count, 0) AS upw,
         COALESCE(w.txn_count, 0) AS txw,
         COALESCE(w.sync_count, 0) AS syw,
         COALESCE(w.recon_count, 0) AS rcw,
         COALESCE(pr.had_bill_upload, false) AS had_bill_upload,
         COALESCE(pr.had_invoice_upload, false) AS had_invoice_upload,
         COALESCE(pr.had_statement_upload, false) AS had_statement_upload,
         COALESCE(pr.had_ap_active, false) AS had_ap_active,
         COALESCE(pr.had_txn_active, false) AS had_txn_active,
         COALESCE(pr.had_gst_recon, false) AS had_gst_recon,
         COALESCE(pr.had_created_bill_or_txn, false) AS had_created_bill_or_txn
  FROM company_activation AS a
  JOIN company_week_value AS v
    ON v.company_id = a.company_id
   AND v.week_start = %(target)s
   AND v.had_value
  JOIN company_profile AS p ON p.company_id = a.company_id
  LEFT JOIN company_week_action AS w
    ON w.company_id = a.company_id
   AND w.week_start = %(target)s
  LEFT JOIN company_week_product AS pr
    ON pr.company_id = a.company_id
   AND pr.week_start = %(target)s
  WHERE a.activation_week = %(cohort)s
  ORDER BY a.company_id
  LIMIT %(cap)s
),
per AS (
  SELECT e.company_id, e.distinct_id,
         max(e.email) FILTER (
           WHERE e.email IS NOT NULL AND e.email <> '') AS email,
         max(e.user_id) FILTER (
           WHERE e.user_id IS NOT NULL AND e.user_id <> '') AS user_id,
         MIN(e.event_time) FILTER (
           WHERE e.event_name = 'Sign Up') AS signup_ev,
         MIN(e.event_time) AS first_ev
  FROM {events} AS e
  WHERE e.company_id IN (SELECT company_id FROM members)
  GROUP BY e.company_id, e.distinct_id
)
SELECT m.company_id, m.activated_at, m.activation_week, m.company_name,
       m.signed_up_at, m.first_sync_at, m.last_action_at,
       m.action_count, m.active_weeks,
       m.path_had_upload, m.path_had_ready,
       m.path_had_sync, m.path_had_recon,
       m.atw, m.upw, m.txw, m.syw, m.rcw,
       m.had_bill_upload, m.had_invoice_upload, m.had_statement_upload,
       m.had_ap_active, m.had_txn_active, m.had_gst_recon,
       m.had_created_bill_or_txn,
       (SELECT COALESCE(
          array_agg(DISTINCT e2.event_name ORDER BY e2.event_name), '{{}}')
        FROM {events} AS e2
        WHERE e2.company_id = m.company_id
          AND e2.event_name = ANY(%(value)s)
          AND (date_trunc('week', e2.event_time AT TIME ZONE 'Asia/Kolkata'))::date
              = %(target)s) AS value_events,
       per.distinct_id, per.email, per.user_id,
       per.signup_ev, per.first_ev
FROM members AS m
LEFT JOIN per ON per.company_id = m.company_id
ORDER BY m.company_id, per.email NULLS LAST, per.distinct_id
"""


def build_cell_payload(
    cohort_week: date,
    rel_week: int,
    rows,
    event_chains: dict[str, dict] | None = None,
) -> dict:
    """Assemble the cell JSON from the single _CELL_SQL round trip.

    company_count is the distinct member companies from the same join
    the heatmap counts, so it agrees with retained_count by construction.
    User-level stats are sum/max across that user's cell companies from
    these same rows; no per-user event scans.
    """
    companies: dict[str, dict] = {}
    order: list[str] = []
    people: list[tuple] = []  # (company_id, distinct_id, email, user_id,
    #                           signup_ev, first_ev)
    for row in rows:
        (company_id, activated_at, _activation_week, company_name,
         signed_up_at, first_sync_at, last_action_at,
         action_count, active_weeks,
         path_had_upload, path_had_ready, path_had_sync, path_had_recon,
         atw, upw, txw, syw, rcw,
         had_bill_upload, had_invoice_upload, had_statement_upload,
         had_ap_active, had_txn_active, had_gst_recon,
         had_created_bill_or_txn,
         value_events,
         distinct_id, email, user_id, signup_ev, first_ev) = row
        if company_id not in companies:
            companies[company_id] = {
                "company_id": company_id,
                "company_name": company_name,
                "signed_up_at": _iso(signed_up_at),
                "activated_at": _iso(activated_at),
                "last_action_at": _iso(last_action_at),
                "lifetime_actions": action_count,
                "active_weeks": active_weeks,
                "actions_per_active_week": _per_week(action_count,
                                                     active_weeks),
                "actions_that_week": atw,
                "upload_that_week": upw,
                "txn_that_week": txw,
                "sync_that_week": syw,
                "recon_that_week": rcw,
                "path_had_upload": bool(path_had_upload),
                "path_had_ready": bool(path_had_ready),
                "path_had_sync": bool(path_had_sync),
                "path_had_recon": bool(path_had_recon),
                "had_bill_upload": bool(had_bill_upload),
                "had_invoice_upload": bool(had_invoice_upload),
                "had_statement_upload": bool(had_statement_upload),
                "had_ap_active": bool(had_ap_active),
                "had_txn_active": bool(had_txn_active),
                "had_gst_recon": bool(had_gst_recon),
                "had_created_bill_or_txn": bool(had_created_bill_or_txn),
                "ttv_hours": _ttv_hours(signed_up_at, first_sync_at),
                "value_events": list(value_events or []),
                "_last_action_dt": last_action_at,
            }
            if event_chains is not None:
                companies[company_id]["event_chain_that_week"] = event_chains.get(
                    company_id,
                    build_event_chain([], scope="that_week"),
                )
            order.append(company_id)
        if distinct_id is not None:
            people.append((company_id, distinct_id, email, user_id,
                           signup_ev, first_ev))

    users: dict[str, dict] = {}
    for company_id, distinct_id, email, user_id, signup_ev, first_ev in people:
        if is_internal_email(email):
            continue
        key = email.lower() if email else (distinct_id or company_id)
        user = users.get(key)
        if user is None:
            user = {
                "email": email,
                "distinct_id": distinct_id,
                "user_id": user_id,
                "signed_up_at": None,
                "_signup_dt": None,
                "last_action_at": None,
                "_last_dt": None,
                "lifetime_actions": 0,
                "active_weeks": 0,
                "actions_that_week": 0,
                "companies": [],
                "_company_ids": set(),
            }
            users[key] = user
        signup_dt = signup_ev or first_ev
        if signup_dt is not None and (
            user["_signup_dt"] is None or signup_dt < user["_signup_dt"]
        ):
            user["_signup_dt"] = signup_dt
            user["signed_up_at"] = _iso(signup_dt)
        company = companies[company_id]
        last_dt = company["_last_action_dt"]
        if last_dt is not None and (
            user["_last_dt"] is None or last_dt > user["_last_dt"]
        ):
            user["_last_dt"] = last_dt
            user["last_action_at"] = _iso(last_dt)
        user["lifetime_actions"] += company["lifetime_actions"]
        user["active_weeks"] = max(user["active_weeks"],
                                   company["active_weeks"])
        user["actions_that_week"] += company["actions_that_week"]
        if company_id not in user["_company_ids"]:
            user["_company_ids"].add(company_id)
            user["companies"].append(company)

    user_list = []
    for user in users.values():
        user["actions_per_active_week"] = _per_week(
            user["lifetime_actions"], user["active_weeks"]
        )
        user["companies"].sort(
            key=lambda c: (c["company_name"] or c["company_id"] or "").lower()
        )
        for company in user["companies"]:
            company.pop("_last_action_dt", None)
        del user["_company_ids"]
        del user["_signup_dt"]
        del user["_last_dt"]
        user_list.append(user)
    user_list.sort(
        key=lambda u: (-u["actions_that_week"],
                       u["email"] or u["distinct_id"] or "")
    )

    that_week = [companies[cid]["actions_that_week"] for cid in order]
    n = len(order)

    def share(key: str, *, count: bool = False) -> float:
        if not n:
            return 0.0
        if count:
            return sum(1 for cid in order if companies[cid][key] > 0) / n
        return sum(1 for cid in order if companies[cid][key]) / n

    payload = {
        "cohort_week": cohort_week.isoformat(),
        "rel_week": rel_week,
        "people_count": len(user_list),
        "company_count": n,
        "median_actions_that_week": statistics.median(that_week) if n else 0,
        "share_with_upload": share("upload_that_week", count=True),
        "share_with_sync": share("sync_that_week", count=True),
        "share_with_recon": share("recon_that_week", count=True),
        "share_with_bill": share("had_bill_upload"),
        "share_with_invoice": share("had_invoice_upload"),
        "share_with_statement": share("had_statement_upload"),
        "share_with_ap": share("had_ap_active"),
        "share_with_txn": share("had_txn_active"),
        "share_with_gst": share("had_gst_recon"),
        "users": user_list,
    }
    return payload


_conn = None
_conn_lock = threading.Lock()


def _connect():
    """Open a Postgres connection. Tests and warmup use this."""
    import psycopg

    return psycopg.connect(get_db_url())


@contextmanager
def _db():
    """Reuse one process connection. Do not close it per request.

    The warehouse is Supabase Sydney. A fresh TLS connect is ~1.6s from
    this host. ``with psycopg.connect() as conn`` closed that session
    on every GET, so heatmap/cell/timeline each paid the handshake
    again. Hold the lock for the query so ThreadingHTTPServer threads
    do not share the connection unsafely.
    """
    global _conn
    with _conn_lock:
        if _conn is None or _conn.closed:
            _conn = _connect()
            _conn.autocommit = True
        try:
            yield _conn
        except Exception:
            try:
                _conn.close()
            except Exception:
                pass
            _conn = None
            raise


class ApiHandler(BaseHTTPRequestHandler):
    server_version = "RetentionAPI/1.0"

    # -- response helpers -------------------------------------------------
    def _send_json(self, status: int, payload) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _bad_request(self, message: str) -> None:
        self._send_json(400, {"error": message})

    # -- routing ----------------------------------------------------------
    def do_GET(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler convention
        try:
            path = urlsplit(self.path).path
            query = urlsplit(self.path).query
            if path == "/health":
                self._send_json(200, {"ok": True})
            elif path == "/api/overview/charts":
                self._overview_charts(query)
            elif path == "/api/overview/slice":
                self._overview_slice(query)
            elif path == "/api/overview":
                self._overview()
            elif path == "/api/summary":
                self._page_summary(query)
            elif path == "/api/heatmap":
                self._heatmap(query)
            elif path == "/api/heatmap/cell":
                self._cell(query)
            elif path.startswith("/api/companies/"):
                rest = path[len("/api/companies/"):]
                if rest.endswith("/timeline") and "/" not in rest[:-len("/timeline")] \
                        and rest[: -len("/timeline")]:
                    company_id = unquote(rest[: -len("/timeline")])
                    self._timeline(company_id, query)
                elif rest.endswith("/summary") and "/" not in rest[:-len("/summary")] \
                        and rest[: -len("/summary")]:
                    company_id = unquote(rest[: -len("/summary")])
                    self._summary(company_id)
                else:
                    self._send_json(404, {"error": "not found"})
            else:
                self._static(path)
        except (ValueError, RuntimeError) as exc:
            self._send_json(500, {"error": str(exc)})

    def _method_not_allowed(self) -> None:
        self._send_json(405, {"error": "method not allowed"})

    do_POST = _method_not_allowed  # noqa: N802
    do_PUT = _method_not_allowed  # noqa: N802
    do_DELETE = _method_not_allowed  # noqa: N802
    do_PATCH = _method_not_allowed  # noqa: N802

    # -- endpoints ----------------------------------------------------------
    def _week_filter(self, query: str) -> tuple[date | None, date | None] | None:
        try:
            return _parse_week_filter(query)
        except ValueError as exc:
            self._bad_request(str(exc))
            return None

    def _overview(self) -> None:
        """Four Overview cards. Active users are people with an action event."""
        try:
            with _db() as conn, conn.cursor() as cur:
                cur.execute(
                    "SELECT"
                    f" (CURRENT_TIMESTAMP AT TIME ZONE '{TIMEZONE}')::date,"
                    f" date_trunc('week', CURRENT_TIMESTAMP AT TIME ZONE '{TIMEZONE}')::date,"
                    f" date_trunc('month', CURRENT_TIMESTAMP AT TIME ZONE '{TIMEZONE}')::date"
                )
                as_of_date, week_start, month_start = cur.fetchone()
                cur.execute(
                    "SELECT"
                    " COUNT(DISTINCT e.distinct_id) FILTER ("
                    f" WHERE (e.event_time AT TIME ZONE '{TIMEZONE}')::date"
                    f" = (CURRENT_TIMESTAMP AT TIME ZONE '{TIMEZONE}')::date"
                    ")::int,"
                    " COUNT(DISTINCT e.distinct_id) FILTER ("
                    f" WHERE date_trunc('week', e.event_time AT TIME ZONE '{TIMEZONE}')"
                    f" = date_trunc('week', CURRENT_TIMESTAMP AT TIME ZONE '{TIMEZONE}')"
                    ")::int,"
                    " COUNT(DISTINCT e.distinct_id) FILTER ("
                    f" WHERE date_trunc('month', e.event_time AT TIME ZONE '{TIMEZONE}')"
                    f" = date_trunc('month', CURRENT_TIMESTAMP AT TIME ZONE '{TIMEZONE}')"
                    ")::int,"
                    " COUNT(DISTINCT e.company_id) FILTER ("
                    f" WHERE date_trunc('week', e.event_time AT TIME ZONE '{TIMEZONE}')"
                    f" = date_trunc('week', CURRENT_TIMESTAMP AT TIME ZONE '{TIMEZONE}')"
                    ")::int,"
                    " COUNT(DISTINCT e.company_id) FILTER ("
                    f" WHERE date_trunc('month', e.event_time AT TIME ZONE '{TIMEZONE}')"
                    f" = date_trunc('month', CURRENT_TIMESTAMP AT TIME ZONE '{TIMEZONE}')"
                    ")::int"
                    " FROM events e"
                    " WHERE e.event_name = ANY(%s)"
                    " AND EXISTS ("
                    " SELECT 1 FROM client_company c WHERE c.company_id = e.company_id"
                    ")"
                    " AND NOT public.is_internal_email(e.email)"
                    " AND e.event_time >= LEAST("
                    f" date_trunc('week', CURRENT_TIMESTAMP AT TIME ZONE '{TIMEZONE}')"
                    f" AT TIME ZONE '{TIMEZONE}',"
                    f" date_trunc('month', CURRENT_TIMESTAMP AT TIME ZONE '{TIMEZONE}')"
                    f" AT TIME ZONE '{TIMEZONE}')",
                    (list(ACTION_EVENTS),),
                )
                dau, wau, mau, wau_companies, mau_companies = cur.fetchone()
                events_table = get_events_table()
                cur.execute(
                    f"""
                    WITH first_seen AS (
                      SELECT
                             date_trunc('week', first_event.event_time
                               AT TIME ZONE '{TIMEZONE}')::date AS first_week,
                             date_trunc('month', first_event.event_time
                               AT TIME ZONE '{TIMEZONE}')::date AS first_month
                      FROM client_company c
                      JOIN LATERAL (
                        SELECT e.event_time FROM {events_table} e
                        WHERE e.company_id = c.company_id
                        ORDER BY e.event_time ASC LIMIT 1
                      ) first_event ON true
                    )
                    SELECT
                      COUNT(*) FILTER (WHERE first_week = %s)::int,
                      COUNT(*) FILTER (WHERE first_month = %s)::int
                    FROM first_seen
                    """,
                    (week_start, month_start),
                )
                new_week, new_month = cur.fetchone()
                cur.execute("SELECT COUNT(*) FROM client_company")
                client_companies = int(cur.fetchone()[0])
                cur.execute("SELECT COUNT(*) FROM company_activation")
                activated = int(cur.fetchone()[0])
                cur.execute(
                    "SELECT cohort_week, cohort_size, retained_count"
                    " FROM retention_cells WHERE rel_week = 8"
                    " AND cohort_week <="
                    " (date_trunc('week',"
                    f" (CURRENT_TIMESTAMP AT TIME ZONE '{TIMEZONE}'))::date"
                    " - 63)"
                    " ORDER BY cohort_week DESC LIMIT 1"
                )
                week8 = cur.fetchone()
        except Exception:
            self._send_json(500, {"error": "overview unavailable"})
            return
        if week8 is None:
            week8_week, week8_n, week8_kept = None, 0, 0
            retention_rate = None
        else:
            week8_week, week8_n, week8_kept = week8
            retention_rate = (week8_kept / week8_n) if week8_n else 0.0
            week8_week = week8_week.isoformat()
        self._send_json(200, {
            "timezone": TIMEZONE,
            "as_of_date": as_of_date.isoformat() if as_of_date else None,
            "week_start": week_start.isoformat() if week_start else None,
            "month_start": month_start.isoformat() if month_start else None,
            "dau": int(dau or 0),
            "wau": int(wau or 0),
            "mau": int(mau or 0),
            "wau_companies": int(wau_companies or 0),
            "mau_companies": int(mau_companies or 0),
            "new_companies_week": int(new_week or 0),
            "new_companies_month": int(new_month or 0),
            "dau_mau_ratio": (dau / mau) if mau else None,
            "client_companies": client_companies,
            "activated": activated,
            "adoption_rate": (
                activated / client_companies if client_companies else 0.0
            ),
            "week8_cohort_week": week8_week,
            "week8_cohort_size": week8_n,
            "week8_retained": week8_kept,
            "customer_retention_rate": retention_rate,
        })

    def _overview_stamps(self, cur):
        cur.execute(
            "SELECT"
            f" (CURRENT_TIMESTAMP AT TIME ZONE '{TIMEZONE}')::date,"
            f" date_trunc('week', CURRENT_TIMESTAMP AT TIME ZONE '{TIMEZONE}')::date,"
            f" date_trunc('month', CURRENT_TIMESTAMP AT TIME ZONE '{TIMEZONE}')::date,"
            f" (date_trunc('month', CURRENT_TIMESTAMP AT TIME ZONE '{TIMEZONE}')"
            "  - INTERVAL '1 month')::date"
        )
        return cur.fetchone()

    def _overview_charts(self, query: str = "") -> None:
        """Overview chart series. Every period is calculated in Asia/Kolkata."""
        try:
            events_table = get_events_table()
            with _db() as conn, conn.cursor() as cur:
                as_of_date, week_start, month_start, prior_month_start = \
                    self._overview_stamps(cur)
                next_month_start = _add_months(month_start, 1)
                week_end = week_start + timedelta(days=7)
                adoption_week = _overview_adoption(
                    cur, events_table, week_start, week_end
                )
                adoption_month = _overview_adoption(
                    cur, events_table, month_start, next_month_start
                )
                engagement_week = _overview_window_counts(
                    cur, events_table, week_start, week_end
                )
                engagement_month = _overview_window_counts(
                    cur, events_table, month_start, next_month_start
                )

                cur.execute(
                    f"""
                    WITH flags AS (
                      SELECT c.company_id,
                             BOOL_OR(e.event_name = 'Upload') AS had_upload,
                             BOOL_OR(e.event_name = ANY(%(ready)s)) AS had_ready,
                             EXISTS (
                               SELECT 1 FROM company_activation a
                               WHERE a.company_id = c.company_id
                             ) AS had_sync
                      FROM client_company c
                      LEFT JOIN {events_table} e
                        ON e.company_id = c.company_id
                       AND e.event_name = ANY(%(funnel_events)s)
                      GROUP BY c.company_id
                    )
                    SELECT COUNT(*)::int,
                           COUNT(*) FILTER (WHERE had_upload)::int,
                           COUNT(*) FILTER (WHERE had_ready)::int,
                           COUNT(*) FILTER (WHERE had_sync)::int
                    FROM flags
                    """,
                    {
                        "ready": list(READY_EVENTS),
                        "funnel_events": ["Upload", *READY_EVENTS],
                    },
                )
                clients, uploads, ready, sync = cur.fetchone()

                prior_wau_start = week_start - timedelta(days=28)
                cur.execute(
                    f"""
                    WITH action_events AS MATERIALIZED (
                      SELECT e.company_id, e.distinct_id,
                             NOT public.is_internal_email(e.email) AS is_person,
                             (e.event_time AT TIME ZONE '{TIMEZONE}')::date AS event_day,
                             (date_trunc('week', e.event_time AT TIME ZONE '{TIMEZONE}'))::date AS event_week,
                             (date_trunc('month', e.event_time AT TIME ZONE '{TIMEZONE}'))::date AS event_month
                      FROM {events_table} e
                      WHERE e.event_name = ANY(%(actions)s)
                        AND EXISTS (
                          SELECT 1 FROM client_company c WHERE c.company_id = e.company_id
                        )
                        AND e.event_time >= ((%(week_start)s::date - 77) AT TIME ZONE '{TIMEZONE}')
                        AND e.event_time < (%(next_month)s::date AT TIME ZONE '{TIMEZONE}')
                    ), weeks AS (
                      SELECT (%(week_start)s::date - 77 + (s.n * 7))::date AS week_start
                      FROM generate_series(0, 11) AS s(n)
                    ), weekly AS (
                      SELECT w.week_start,
                             COUNT(DISTINCT a.distinct_id) FILTER (WHERE a.is_person)::int AS people,
                             COUNT(DISTINCT a.company_id)::int AS companies
                      FROM weeks w LEFT JOIN action_events a ON a.event_week = w.week_start
                      GROUP BY w.week_start
                    ), daily AS (
                      SELECT event_day, COUNT(DISTINCT distinct_id) FILTER (WHERE is_person)::int AS people
                      FROM action_events GROUP BY event_day
                    ), periods AS (
                      SELECT
                        COUNT(DISTINCT distinct_id) FILTER (
                          WHERE is_person AND event_day = %(as_of)s::date
                        )::int AS current_dau,
                        COUNT(DISTINCT distinct_id) FILTER (
                          WHERE is_person AND event_week = %(week_start)s::date
                        )::int AS current_wau,
                        COUNT(DISTINCT distinct_id) FILTER (
                          WHERE is_person AND event_month = %(month_start)s::date
                        )::int AS current_mau,
                        COUNT(DISTINCT distinct_id) FILTER (
                          WHERE is_person AND event_week = %(prior_wau)s::date
                        )::int AS prior_wau,
                        COUNT(DISTINCT distinct_id) FILTER (
                          WHERE is_person AND event_month = %(prior_month)s::date
                        )::int AS prior_mau
                      FROM action_events
                    ), prior_days AS (
                      SELECT day::date FROM generate_series(
                        %(prior_month)s::date, %(month_start)s::date - 1, INTERVAL '1 day'
                      ) AS day
                    )
                    SELECT
                      COALESCE((
                        SELECT json_agg(json_build_object(
                          'week_start', week_start, 'people', people, 'companies', companies
                        ) ORDER BY week_start) FROM weekly
                      ), '[]'::json),
                      current_dau, current_wau, current_mau, prior_wau, prior_mau,
                      COALESCE((
                        SELECT AVG(COALESCE(d.people, 0)) FROM prior_days p
                        LEFT JOIN daily d ON d.event_day = p.day
                      ), 0)
                    FROM periods
                    """,
                    {
                        "actions": list(ACTION_EVENTS),
                        "as_of": as_of_date,
                        "week_start": week_start,
                        "month_start": month_start,
                        "prior_month": prior_month_start,
                        "prior_wau": prior_wau_start,
                        "next_month": next_month_start,
                    },
                )
                (weekly_data, current_dau, current_wau, current_mau,
                 prior_wau, prior_mau, prior_dau) = cur.fetchone()
                if isinstance(weekly_data, str):
                    weekly_data = json.loads(weekly_data)
                weekly_rows = [
                    (
                        date.fromisoformat(str(item["week_start"])[:10]),
                        int(item["people"] or 0),
                        int(item["companies"] or 0),
                    )
                    for item in (weekly_data or [])
                ]
                current_dau = int(current_dau or 0)
                current_wau = int(current_wau or 0)
                current_mau = int(current_mau or 0)
                prior_wau = int(prior_wau or 0)
                prior_mau = int(prior_mau or 0)
                prior_dau = round(float(prior_dau or 0), 1)

                cur.execute(
                    f"""
                    WITH months AS (
                      SELECT (%(month_start)s::date - INTERVAL '7 months'
                              + (s.n * INTERVAL '1 month'))::date AS month
                      FROM generate_series(0, 7) AS s(n)
                    ), first_seen AS (
                      SELECT c.company_id,
                             date_trunc('month', first_event.event_time AT TIME ZONE '{TIMEZONE}')::date
                               AS first_month
                      FROM client_company c
                      JOIN LATERAL (
                        SELECT e.event_time FROM {events_table} e
                        WHERE e.company_id = c.company_id
                        ORDER BY e.event_time ASC LIMIT 1
                      ) first_event ON true
                    )
                    SELECT m.month,
                           COUNT(f.company_id) FILTER (WHERE a.company_id IS NOT NULL)::int,
                           COUNT(f.company_id) FILTER (WHERE a.company_id IS NULL)::int
                    FROM months m
                    LEFT JOIN first_seen f ON f.first_month = m.month
                    LEFT JOIN company_activation a ON a.company_id = f.company_id
                    GROUP BY m.month
                    ORDER BY m.month
                    """,
                    {"month_start": month_start},
                )
                vintage_rows = cur.fetchall()

                cur.execute(
                    f"""
                    WITH months AS (
                      SELECT (%(month_start)s::date - INTERVAL '5 months'
                              + (s.n * INTERVAL '1 month'))::date AS month
                      FROM generate_series(0, 5) AS s(n)
                    ), action_months AS (
                      SELECT DISTINCT e.distinct_id,
                             date_trunc('month', e.event_time AT TIME ZONE '{TIMEZONE}')::date
                               AS month
                      FROM {events_table} e
                      JOIN (
                        SELECT DISTINCT e.distinct_id
                        FROM {events_table} e
                        WHERE e.event_name = ANY(%(actions)s)
                          AND NOT public.is_internal_email(e.email)
                          AND EXISTS (
                            SELECT 1 FROM client_company c WHERE c.company_id = e.company_id
                          )
                          AND e.event_time >= ((%(month_start)s::date - INTERVAL '5 months') AT TIME ZONE '{TIMEZONE}')
                          AND e.event_time < ((%(month_start)s::date + INTERVAL '1 month') AT TIME ZONE '{TIMEZONE}')
                      ) recent ON recent.distinct_id = e.distinct_id
                      WHERE e.event_name = ANY(%(actions)s)
                        AND NOT public.is_internal_email(e.email)
                        AND EXISTS (
                          SELECT 1 FROM client_company c WHERE c.company_id = e.company_id
                        )
                    ), first_action AS (
                      SELECT distinct_id, MIN(month) AS first_month
                      FROM action_months
                      GROUP BY distinct_id
                    )
                    SELECT m.month,
                           COUNT(a.distinct_id) FILTER (
                             WHERE f.first_month = m.month
                           )::int AS new_people,
                           COUNT(a.distinct_id) FILTER (
                             WHERE f.first_month < m.month
                               AND EXISTS (
                                 SELECT 1 FROM action_months prev
                                 WHERE prev.distinct_id = a.distinct_id
                                   AND prev.month = (m.month - INTERVAL '1 month')::date
                               )
                           )::int AS returning_people,
                           COUNT(a.distinct_id) FILTER (
                             WHERE f.first_month < m.month
                               AND NOT EXISTS (
                                 SELECT 1 FROM action_months prev
                                 WHERE prev.distinct_id = a.distinct_id
                                   AND prev.month = (m.month - INTERVAL '1 month')::date
                               )
                           )::int AS resurrected_people
                    FROM months m
                    LEFT JOIN action_months a ON a.month = m.month
                    LEFT JOIN first_action f ON f.distinct_id = a.distinct_id
                    GROUP BY m.month
                    ORDER BY m.month
                    """,
                    {"month_start": month_start, "actions": list(ACTION_EVENTS)},
                )
                composition_rows = cur.fetchall()

                cur.execute(
                    "SELECT cohort_week, cohort_size, retained_count"
                    " FROM retention_cells WHERE rel_week = 8"
                    " AND cohort_week <= %(mature)s"
                    " ORDER BY cohort_week DESC LIMIT 8",
                    {"mature": week_start - timedelta(days=63)},
                )
                week8_rows = list(reversed(cur.fetchall()))

                activation_start = week_start - timedelta(days=77)
                cur.execute(
                    "SELECT activation_week, COUNT(*)::int"
                    " FROM company_activation"
                    " WHERE activation_week >= %s AND activation_week <= %s"
                    " GROUP BY activation_week",
                    (activation_start, week_start),
                )
                activations = {row[0]: int(row[1] or 0) for row in cur.fetchall()}
                cur.execute(
                    "SELECT cohort_week, cohort_size, retained_count"
                    " FROM retention_cells WHERE rel_week = 8"
                    " AND cohort_week >= %s AND cohort_week <= %s",
                    (activation_start, week_start),
                )
                table_week8 = {row[0]: (int(row[1] or 0), int(row[2] or 0))
                               for row in cur.fetchall()}
                complete_week = week_start - timedelta(days=7)
                cur.execute(
                    "SELECT"
                    " COUNT(*) FILTER (WHERE had_bill_upload)::int,"
                    " COUNT(*) FILTER (WHERE had_invoice_upload)::int,"
                    " COUNT(*) FILTER (WHERE had_statement_upload)::int,"
                    " COUNT(*) FILTER (WHERE had_ap_active)::int,"
                    " COUNT(*) FILTER (WHERE had_txn_active)::int,"
                    " COUNT(*) FILTER (WHERE had_gst_recon)::int"
                    " FROM company_week_product WHERE week_start = %s",
                    (complete_week,),
                )
                product_counts = cur.fetchone() or (0, 0, 0, 0, 0, 0)
                feature_usage = _feature_usage_payload(cur, events_table, complete_week)
                cur.execute(
                    f"""
                    WITH weeks AS (
                      SELECT (%(week_start)s::date - 77 + (s.n * 7))::date AS week_start
                      FROM generate_series(0, 11) AS s(n)
                    ), first_seen AS (
                      SELECT date_trunc('week', first_event.event_time
                               AT TIME ZONE '{TIMEZONE}')::date AS first_week
                      FROM client_company c
                      JOIN LATERAL (
                        SELECT e.event_time FROM {events_table} e
                        WHERE e.company_id = c.company_id
                        ORDER BY e.event_time ASC LIMIT 1
                      ) first_event ON true
                    )
                    SELECT w.week_start, COUNT(f.first_week)::int
                    FROM weeks w
                    LEFT JOIN first_seen f ON f.first_week = w.week_start
                    GROUP BY w.week_start
                    ORDER BY w.week_start
                    """,
                    {"week_start": week_start},
                )
                growth_rows = cur.fetchall()
                cur.execute(
                    f"""
                    WITH months AS (
                      SELECT (%(month_start)s::date - INTERVAL '5 months'
                              + (s.n * INTERVAL '1 month'))::date AS month
                      FROM generate_series(0, 5) AS s(n)
                    ), activity AS (
                      SELECT
                             date_trunc('month', e.event_time AT TIME ZONE '{TIMEZONE}')::date
                               AS month,
                             COUNT(DISTINCT e.distinct_id) FILTER (
                               WHERE NOT public.is_internal_email(e.email)
                             )::int AS people,
                             COUNT(DISTINCT e.company_id)::int AS companies
                      FROM {events_table} e
                      WHERE e.event_name = ANY(%(actions)s)
                        AND EXISTS (
                          SELECT 1 FROM client_company c WHERE c.company_id = e.company_id
                        )
                        AND e.event_time >= ((%(month_start)s::date - INTERVAL '5 months')
                          AT TIME ZONE '{TIMEZONE}')
                        AND e.event_time < ((%(month_start)s::date + INTERVAL '1 month')
                          AT TIME ZONE '{TIMEZONE}')
                      GROUP BY 1
                    )
                    SELECT m.month,
                           COALESCE(a.people, 0)::int,
                           COALESCE(a.companies, 0)::int
                    FROM months m
                    LEFT JOIN activity a ON a.month = m.month
                    ORDER BY m.month
                    """,
                    {"month_start": month_start, "actions": list(ACTION_EVENTS)},
                )
                monthly_rows = cur.fetchall()
                module_week = _module_usage_payload(
                    cur, events_table, complete_week, week_start, "week"
                )
                module_month = _module_usage_payload(
                    cur, events_table, month_start, next_month_start, "month"
                )
                module_usage = {
                    # The direct fields preserve the latest-complete-week
                    # contract used by the Overview module map. `periods`
                    # adds the explicit week/month switch without changing
                    # the established feature_usage response.
                    "default_period": "week",
                    "window_start": module_week["period_start"],
                    "window_end": module_week["period_end"],
                    "granularity": module_week["granularity"],
                    "modules": module_week["modules"],
                    "windows": [
                        {
                            "key": "week",
                            "label": "Latest complete week",
                            "granularity": "week",
                            "start": module_week["period_start"],
                            "end": module_week["period_end"],
                            "complete": True,
                        },
                        {
                            "key": "month",
                            "label": "Current month",
                            "granularity": "month",
                            "start": module_month["period_start"],
                            "end": module_month["period_end"],
                            "complete": False,
                        },
                    ],
                    "week": module_week,
                    "month": module_month,
                    "periods": {
                        "week": module_week,
                        "month": module_month,
                    },
                }
        except Exception:
            self._send_json(500, {"error": "overview charts unavailable"})
            return

        weekly = [
            {
                "week_start": item_week.isoformat(),
                "people": int(people or 0),
                "companies": int(companies or 0),
                "current": item_week == week_start,
            }
            for item_week, people, companies in weekly_rows
        ]
        weekly_table = []
        mature_cutoff = week_start - timedelta(days=63)
        for item_week, people, companies in weekly_rows:
            mature = item_week <= mature_cutoff
            retained_size = table_week8.get(item_week) if mature else None
            weekly_table.append({
                "week_start": item_week.isoformat(),
                "people": int(people or 0),
                "companies": int(companies or 0),
                "activations": activations.get(item_week, 0),
                "week8_cohort_size": retained_size[0] if retained_size else None,
                "week8_retained": retained_size[1] if retained_size else None,
            })
        period_rows = [
            {
                "key": "dau", "label": "DAU", "current": current_dau,
                "prior": prior_dau, "prior_kind": "average_daily",
                "current_start": as_of_date.isoformat(),
                "current_end": (as_of_date + timedelta(days=1)).isoformat(),
                "prior_start": prior_month_start.isoformat(),
                "prior_end": month_start.isoformat(),
            },
            {
                "key": "wau", "label": "WAU", "current": current_wau,
                "prior": prior_wau, "prior_kind": "week",
                "current_start": week_start.isoformat(),
                "current_end": week_end.isoformat(),
                "prior_start": prior_wau_start.isoformat(),
                "prior_end": (prior_wau_start + timedelta(days=7)).isoformat(),
            },
            {
                "key": "mau", "label": "MAU", "current": current_mau,
                "prior": prior_mau, "prior_kind": "month",
                "current_start": month_start.isoformat(),
                "current_end": next_month_start.isoformat(),
                "prior_start": prior_month_start.isoformat(),
                "prior_end": month_start.isoformat(),
            },
        ]
        monthly_points = [
            {
                "month": item_month.isoformat(),
                "people": int(people or 0),
                "companies": int(companies or 0),
                "current": item_month == month_start,
            }
            for item_month, people, companies in monthly_rows
        ]
        engagement = {
            "week": {
                **engagement_week,
                "start": week_start.isoformat(),
                "end": week_end.isoformat(),
            },
            "month": {
                **engagement_month,
                "start": month_start.isoformat(),
                "end": next_month_start.isoformat(),
            },
            "windows": [
                {
                    "key": "week", "label": "Weekly", "granularity": "week",
                    "start": week_start.isoformat(), "end": week_end.isoformat(),
                    "current": True, "complete": False,
                },
                {
                    "key": "month", "label": "Monthly", "granularity": "month",
                    "start": month_start.isoformat(), "end": next_month_start.isoformat(),
                    "current": True, "complete": False,
                },
            ],
            "weekly": weekly,
            "monthly": monthly_points,
            "period": period_rows,
        }
        self._send_json(200, {
            "timezone": TIMEZONE,
            "as_of_date": as_of_date.isoformat(),
            "week_start": week_start.isoformat(),
            "month_start": month_start.isoformat(),
            "prior_month_start": prior_month_start.isoformat(),
            "adoption": {
                "default_period": "month",
                "windows": [adoption_week, adoption_month],
                "week": adoption_week,
                "month": adoption_month,
                "periods": {
                    "week": adoption_week,
                    "month": adoption_month,
                },
            },
            "engagement": engagement,
            "modules": module_usage["modules"],
            "module_usage": module_usage,
            "funnel": [
                {"key": "clients", "label": "Client companies", "remaining": int(clients or 0)},
                {"key": "upload", "label": "Upload", "remaining": int(uploads or 0)},
                {"key": "ready", "label": "Ready", "remaining": int(ready or 0)},
                {"key": "sync", "label": "Activated", "remaining": int(sync or 0)},
            ],
            "weekly": weekly,
            "period": period_rows,
            "vintage": [
                {
                    "month": item_month.isoformat(),
                    "activated": int(activated or 0),
                    "not_activated": int(not_activated or 0),
                    "current": item_month == month_start,
                }
                for item_month, activated, not_activated in vintage_rows
            ],
            "composition": [
                {
                    "month": item_month.isoformat(),
                    "new": int(new_people or 0),
                    "returning": int(returning_people or 0),
                    "resurrected": int(resurrected_people or 0),
                    "current": item_month == month_start,
                }
                for item_month, new_people, returning_people, resurrected_people
                in composition_rows
            ],
            "week8": [
                {
                    "cohort_week": cohort_week.isoformat(),
                    "cohort_size": int(cohort_size or 0),
                    "retained": int(retained_count or 0),
                    "dropped": max(int(cohort_size or 0) - int(retained_count or 0), 0),
                }
                for cohort_week, cohort_size, retained_count in week8_rows
            ],
            "weekly_table": weekly_table,
            "growth": [
                {
                    "week_start": item_week.isoformat(),
                    "companies": int(companies or 0),
                    "current": item_week == week_start,
                }
                for item_week, companies in growth_rows
            ],
            "monthly": monthly_points,
            "feature_usage": feature_usage,
            "product": [
                {
                    "key": key,
                    "label": label,
                    "companies": int(count or 0),
                    "week_start": complete_week.isoformat(),
                }
                for (key, label), count in zip(PRODUCT_SPLIT_FLAGS, product_counts)
            ],
        })

    def _overview_slice_payload(self, company_ids: list[str],
                                pairs: list[tuple[str, str]] | None = None) -> dict:
        """Return the Retention-style people payload for a chart membership."""
        ordered_ids = list(dict.fromkeys(str(cid) for cid in company_ids))
        ordered_ids = ordered_ids[:CELL_COMPANY_LIMIT]
        if not ordered_ids:
            return {"people_count": 0, "company_count": 0, "users": []}
        selected_ids = set(ordered_ids)
        if pairs is not None:
            pairs = [
                (str(company_id), str(distinct_id))
                for company_id, distinct_id in pairs
                if company_id in selected_ids and distinct_id
            ]
            if not pairs:
                return {
                    "people_count": 0,
                    "company_count": len(ordered_ids),
                    "users": [],
                }
        events_table = get_events_table()
        if pairs is None:
            per_sql = f"""
            per AS (
              SELECT e.company_id, e.distinct_id,
                     MAX(e.email) FILTER (
                       WHERE e.email IS NOT NULL AND e.email <> '') AS email,
                     MAX(e.user_id) FILTER (
                       WHERE e.user_id IS NOT NULL AND e.user_id <> '') AS user_id,
                     MIN(e.event_time) FILTER (WHERE e.event_name = 'Sign Up') AS signup_ev,
                     MIN(e.event_time) AS first_ev
              FROM {events_table} e
              JOIN selected_companies sc ON sc.company_id = e.company_id
              WHERE e.distinct_id IS NOT NULL
                AND NOT public.is_internal_email(e.email)
              GROUP BY e.company_id, e.distinct_id
            )
            """
            params = {"company_ids": ordered_ids, "actions": list(ACTION_EVENTS)}
        else:
            per_sql = f"""
            selected_pairs AS (
              SELECT * FROM UNNEST(
                %(pair_company_ids)s::text[], %(pair_distinct_ids)s::text[]
              ) AS selected(company_id, distinct_id)
            ), per AS (
              SELECT sp.company_id, sp.distinct_id,
                     MAX(e.email) FILTER (
                       WHERE e.email IS NOT NULL AND e.email <> '') AS email,
                     MAX(e.user_id) FILTER (
                       WHERE e.user_id IS NOT NULL AND e.user_id <> '') AS user_id,
                     MIN(e.event_time) FILTER (WHERE e.event_name = 'Sign Up') AS signup_ev,
                     MIN(e.event_time) AS first_ev
              FROM selected_pairs sp
              JOIN {events_table} e
                ON e.company_id = sp.company_id AND e.distinct_id = sp.distinct_id
              WHERE NOT public.is_internal_email(e.email)
              GROUP BY sp.company_id, sp.distinct_id
            )
            """
            params = {
                "company_ids": ordered_ids,
                "pair_company_ids": [pair[0] for pair in pairs],
                "pair_distinct_ids": [pair[1] for pair in pairs],
                "actions": list(ACTION_EVENTS),
            }
        sql = f"""
        WITH selected_companies AS (
          SELECT UNNEST(%(company_ids)s::text[]) AS company_id
        ), company_stats AS (
          SELECT sc.company_id,
                 p.activated_at, p.activation_week,
                 COALESCE(p.company_name, stats.company_name) AS company_name,
                 COALESCE(p.signed_up_at, stats.company_created_at, stats.first_event_at) AS signed_up_at,
                 COALESCE(p.first_sync_at, stats.first_sync_at) AS first_sync_at,
                 COALESCE(p.last_action_at, stats.last_action_at) AS last_action_at,
                 COALESCE(p.action_count, stats.action_count, 0)::int AS action_count,
                 COALESCE(p.active_weeks, stats.active_weeks, 0)::int AS active_weeks,
                 COALESCE(p.path_had_upload, false) AS path_had_upload,
                 COALESCE(p.path_had_ready, false) AS path_had_ready,
                 COALESCE(p.path_had_sync, false) AS path_had_sync,
                 COALESCE(p.path_had_recon, false) AS path_had_recon
          FROM selected_companies sc
          LEFT JOIN company_profile p ON p.company_id = sc.company_id
          LEFT JOIN LATERAL (
            SELECT MAX(e.properties->>'companyName') AS company_name,
                   MIN(e.event_time) FILTER (WHERE e.event_name = 'Company Created')
                     AS company_created_at,
                   MIN(e.event_time) AS first_event_at,
                   MIN(e.event_time) FILTER (WHERE e.event_name = 'Accounting Sync')
                     AS first_sync_at,
                   MAX(e.event_time) FILTER (WHERE e.event_name = ANY(%(actions)s))
                     AS last_action_at,
                   COUNT(*) FILTER (WHERE e.event_name = ANY(%(actions)s))::int
                     AS action_count,
                   COUNT(DISTINCT date_trunc('week', e.event_time AT TIME ZONE '{TIMEZONE}'))
                     FILTER (WHERE e.event_name = ANY(%(actions)s))::int AS active_weeks
            FROM {events_table} e
            WHERE e.company_id = sc.company_id
          ) stats ON true
        ),
        {per_sql}
        SELECT cs.company_id, cs.activated_at, cs.activation_week, cs.company_name,
               cs.signed_up_at, cs.first_sync_at, cs.last_action_at,
               cs.action_count, cs.active_weeks,
               cs.path_had_upload, cs.path_had_ready,
               cs.path_had_sync, cs.path_had_recon,
               0::int AS atw, 0::int AS upw, 0::int AS txw,
               0::int AS syw, 0::int AS rcw,
               false AS had_bill_upload, false AS had_invoice_upload,
               false AS had_statement_upload, false AS had_ap_active,
               false AS had_txn_active, false AS had_gst_recon,
               false AS had_created_bill_or_txn,
               ARRAY[]::text[] AS value_events,
               per.distinct_id, per.email, per.user_id, per.signup_ev, per.first_ev
        FROM company_stats cs
        LEFT JOIN per ON per.company_id = cs.company_id
        ORDER BY cs.company_id, per.email NULLS LAST, per.distinct_id
        """
        with _db() as conn, conn.cursor() as cur:
            cur.execute(sql, params)
            rows = cur.fetchall()
        payload = build_cell_payload(date(1970, 1, 5), 0, rows)
        return {
            "people_count": payload["people_count"],
            "company_count": len(ordered_ids),
            "users": payload["users"],
        }

    def _overview_slice_company_ids(self, sql: str, params: dict | None = None) -> list[str]:
        with _db() as conn, conn.cursor() as cur:
            cur.execute(sql, params or {})
            return [str(row[0]) for row in cur.fetchall()][:CELL_COMPANY_LIMIT]

    def _overview_slice_pairs(self, sql: str, params: dict | None = None) -> list[tuple[str, str]]:
        with _db() as conn, conn.cursor() as cur:
            cur.execute(sql, params or {})
            rows = cur.fetchall()
        return [(str(company_id), str(distinct_id))
                for company_id, distinct_id in rows if company_id and distinct_id]

    def _cell_payload(self, cohort_week: date, rel_week: int) -> dict:
        target_week = cohort_week + timedelta(days=rel_week * 7)
        events_table = get_events_table()
        sql = _CELL_SQL.format(events=events_table)
        event_chains = defaultdict(list)
        with _db() as conn, conn.cursor() as cur:
            cur.execute(
                sql,
                {
                    "cohort": cohort_week,
                    "target": target_week,
                    "cap": CELL_COMPANY_LIMIT,
                    "value": list(VALUE_EVENTS),
                },
            )
            rows = cur.fetchall()
            company_ids = list(dict.fromkeys(row[0] for row in rows))
            if company_ids:
                cur.execute(
                    f"SELECT company_id, event_name, event_time, properties"
                    f" FROM {events_table}"
                    " WHERE company_id = ANY(%s)"
                    "   AND event_name = ANY(%s)"
                    f"   AND date_trunc('week', event_time AT TIME ZONE %s)::date = %s"
                    " ORDER BY company_id, event_time ASC, insert_id ASC",
                    (company_ids, list(CHAIN_EVENT_NAMES), TIMEZONE, target_week),
                )
                for company_id, event_name, event_time, properties in cur.fetchall():
                    event_chains[company_id].append(
                        (event_name, event_time, properties)
                    )
        chains = {
            company_id: build_event_chain(rows_, scope="that_week")
            for company_id, rows_ in event_chains.items()
        }
        return build_cell_payload(cohort_week, rel_week, rows, chains)

    def _overview_slice(self, query: str) -> None:
        """People/company membership for a labelled Overview chart segment."""
        params = parse_qs(query, keep_blank_values=True)
        chart = (params.get("chart") or [None])[0]
        key = (params.get("key") or [None])[0]
        try:
            if chart not in {
                "funnel", "adoption", "weekly", "period", "vintage", "composition", "week8",
                "family", "product", "feature", "module", "module_usage", "growth", "monthly",
            }:
                raise ValueError("chart must be a supported Overview chart")
            if not key:
                raise ValueError("key is required")
            events_table = get_events_table()

            if chart == "funnel":
                if key not in {"clients", "upload", "ready", "sync"}:
                    raise ValueError("invalid funnel key")
                mode = (params.get("mode") or ["reached"])[0]
                if mode not in {"reached", "dropped"}:
                    raise ValueError("mode must be reached or dropped")
                if key == "clients" and mode == "dropped":
                    raise ValueError("clients has no prior funnel step")
                conditions = {
                    "clients": "TRUE",
                    "upload": (
                        f"EXISTS (SELECT 1 FROM {events_table} e "
                        "WHERE e.company_id = c.company_id AND e.event_name = 'Upload')"
                    ),
                    "ready": (
                        f"EXISTS (SELECT 1 FROM {events_table} e "
                        "WHERE e.company_id = c.company_id "
                        "AND e.event_name IN ('Invoice Created', 'Transaction Ledger Updated'))"
                    ),
                    "sync": (
                        "EXISTS (SELECT 1 FROM company_activation a "
                        "WHERE a.company_id = c.company_id)"
                    ),
                }
                ordered = ["clients", "upload", "ready", "sync"]
                if mode == "reached":
                    where = conditions[key]
                else:
                    previous = ordered[ordered.index(key) - 1]
                    where = f"({conditions[previous]}) AND NOT ({conditions[key]})"
                company_ids = self._overview_slice_company_ids(
                    f"SELECT c.company_id FROM client_company c WHERE {where} ORDER BY c.company_id"
                )
                payload = self._overview_slice_payload(company_ids)

            elif chart == "adoption":
                if key not in {"signup", "integration", "upload", "ready", "sync", "activation", "active"}:
                    raise ValueError("invalid adoption key")
                mode = (params.get("mode") or ["reached"])[0]
                if mode not in {"reached", "dropped"}:
                    raise ValueError("mode must be reached or dropped")
                ordered = ["signup", "integration", "upload", "ready", "sync", "active"]
                if key == "signup" and mode == "dropped":
                    raise ValueError("signup has no prior adoption step")
                granularity = (params.get("period") or params.get("granularity") or [None])[0]
                granularity = "month" if granularity == "month" or params.get("month") else "week"
                raw_start = (params.get("month") if granularity == "month" else params.get("week")) or params.get("window_start")
                start = _exact_date(
                    (raw_start or [None])[0],
                    "month" if granularity == "month" else "week",
                    monday=granularity == "week",
                    month_start=granularity == "month",
                )
                end = _add_months(start, 1) if granularity == "month" else start + timedelta(days=7)
                conditions = {
                    "signup": "TRUE",
                    "integration": (
                        f"EXISTS (SELECT 1 FROM {events_table} e "
                        f"WHERE e.company_id = f.company_id AND e.event_name = '{INTEGRATION_EVENT}' "
                        "AND e.event_time >= f.first_at)"
                    ),
                    "upload": (
                        f"EXISTS (SELECT 1 FROM {events_table} e "
                        "WHERE e.company_id = f.company_id AND e.event_name = 'Upload' "
                        "AND e.event_time >= f.first_at)"
                    ),
                    "ready": (
                        f"EXISTS (SELECT 1 FROM {events_table} e "
                        "WHERE e.company_id = f.company_id AND e.event_name = ANY(%(ready)s) "
                        "AND e.event_time >= f.first_at)"
                    ),
                    "activation": (
                        "f.integration_at IS NOT NULL AND f.sync_at IS NOT NULL "
                        "AND f.sync_at >= f.integration_at"
                    ),
                    "sync": (
                        "f.integration_at IS NOT NULL AND f.sync_at IS NOT NULL "
                        "AND f.sync_at >= f.integration_at"
                    ),
                    "active": (
                        f"f.integration_at IS NOT NULL AND f.sync_at IS NOT NULL "
                        f"AND f.sync_at >= f.integration_at AND EXISTS (SELECT 1 FROM {events_table} e "
                        "WHERE e.company_id = f.company_id AND e.event_name = ANY(%(actions)s) "
                        "AND e.distinct_id IS NOT NULL "
                        "AND NOT public.is_internal_email(e.email) "
                        "AND e.event_time >= (%(start)s::date::timestamp AT TIME ZONE "
                        f"'{TIMEZONE}') AND e.event_time < (%(end)s::date::timestamp AT TIME ZONE "
                        f"'{TIMEZONE}') AND e.event_time >= f.sync_at)"
                    ),
                }
                current_condition = conditions[key]
                if mode == "dropped":
                    previous_condition = conditions[ordered[ordered.index(key) - 1]]
                    membership = f"({previous_condition}) AND NOT ({current_condition})"
                else:
                    membership = current_condition
                company_ids = self._overview_slice_company_ids(
                    f"""
                    WITH first_seen AS (
                      SELECT c.company_id,
                             COALESCE(
                               MIN(e.event_time) FILTER (WHERE e.event_name = 'Company Created'),
                               MIN(e.event_time)
                             ) AS first_at,
                             MIN(e.event_time) FILTER (
                               WHERE e.event_name = '{INTEGRATION_EVENT}'
                             ) AS integration_at,
                             MIN(e.event_time) FILTER (
                               WHERE e.event_name = 'Accounting Sync'
                             ) AS sync_at
                      FROM client_company c
                      JOIN {events_table} e ON e.company_id = c.company_id
                      GROUP BY c.company_id
                    )
                    SELECT f.company_id
                    FROM first_seen f
                    WHERE f.first_at >= (%(start)s::date::timestamp AT TIME ZONE '{TIMEZONE}')
                      AND f.first_at < (%(end)s::date::timestamp AT TIME ZONE '{TIMEZONE}')
                      AND {membership}
                    ORDER BY f.company_id
                    """,
                    {
                        "actions": list(ACTION_EVENTS),
                        "ready": list(READY_EVENTS),
                        "start": start,
                        "end": end,
                    },
                )
                payload = self._overview_slice_payload(company_ids)
                with _db() as conn, conn.cursor() as cur:
                    adoption = _overview_adoption(
                        cur,
                        events_table,
                        start,
                        end,
                    )
                payload["adoption"] = {
                    "key": key,
                    "mode": mode,
                    "granularity": granularity,
                    "window_start": start.isoformat(),
                    "window_end": end.isoformat(),
                    "stage": next(
                        (stage for stage in adoption["stages"] if stage["key"] == key),
                        None,
                    ),
                }

            elif chart == "weekly":
                if key not in {"people", "companies"}:
                    raise ValueError("invalid weekly key")
                week = _exact_date((params.get("week") or [None])[0], "week", monday=True)
                active_where = (
                    f"e.event_name = ANY(%(actions)s)"
                    f" AND (date_trunc('week', e.event_time AT TIME ZONE '{TIMEZONE}'))::date = %(week)s"
                    " AND EXISTS (SELECT 1 FROM client_company c WHERE c.company_id = e.company_id)"
                )
                pairs_sql = f"""
                    SELECT DISTINCT e.company_id, e.distinct_id FROM {events_table} e
                    WHERE {active_where} AND e.distinct_id IS NOT NULL
                      AND NOT public.is_internal_email(e.email)
                    ORDER BY e.company_id, e.distinct_id
                """
                pairs = self._overview_slice_pairs(
                    pairs_sql, {"actions": list(ACTION_EVENTS), "week": week}
                )
                if key == "people":
                    company_ids = list(dict.fromkeys(pair[0] for pair in pairs))
                else:
                    company_ids = self._overview_slice_company_ids(
                        f"SELECT DISTINCT e.company_id FROM {events_table} e"
                        f" WHERE {active_where} ORDER BY e.company_id",
                        {"actions": list(ACTION_EVENTS), "week": week},
                    )
                payload = self._overview_slice_payload(company_ids, pairs)

            elif chart == "period":
                if key not in {"dau", "wau", "mau"}:
                    raise ValueError("invalid period key")
                which = (params.get("which") or [None])[0]
                if which not in {"current", "prior"}:
                    raise ValueError("which must be current or prior")
                with _db() as conn, conn.cursor() as cur:
                    as_of_date, week_start, month_start, prior_month_start = self._overview_stamps(cur)
                next_month_start = _add_months(month_start, 1)
                if which == "current":
                    windows = {
                        "dau": (as_of_date, as_of_date + timedelta(days=1)),
                        "wau": (week_start, week_start + timedelta(days=7)),
                        "mau": (month_start, next_month_start),
                    }
                else:
                    prior_week = week_start - timedelta(days=28)
                    windows = {
                        # Prior DAU is the prior calendar-month daily-average comparison.
                        # The drill intentionally lists its contributing monthly people.
                        "dau": (prior_month_start, month_start),
                        "wau": (prior_week, prior_week + timedelta(days=7)),
                        "mau": (prior_month_start, month_start),
                    }
                start, end = windows[key]
                pairs = self._overview_slice_pairs(
                    f"""
                    SELECT DISTINCT e.company_id, e.distinct_id FROM {events_table} e
                    WHERE e.event_name = ANY(%(actions)s)
                      AND NOT public.is_internal_email(e.email)
                      AND e.distinct_id IS NOT NULL
                      AND EXISTS (SELECT 1 FROM client_company c WHERE c.company_id = e.company_id)
                      AND e.event_time >= (%(start)s::date AT TIME ZONE '{TIMEZONE}')
                      AND e.event_time < (%(end)s::date AT TIME ZONE '{TIMEZONE}')
                    ORDER BY e.company_id, e.distinct_id
                    """,
                    {"actions": list(ACTION_EVENTS), "start": start, "end": end},
                )
                payload = self._overview_slice_payload(
                    list(dict.fromkeys(pair[0] for pair in pairs)), pairs
                )

            elif chart == "vintage":
                if key not in {"activated", "not_activated"}:
                    raise ValueError("invalid vintage key")
                month = _exact_date(
                    (params.get("month") or [None])[0], "month", month_start=True
                )
                activation_clause = (
                    "a.company_id IS NOT NULL" if key == "activated" else "a.company_id IS NULL"
                )
                company_ids = self._overview_slice_company_ids(
                    f"""
                    WITH first_seen AS (
                      SELECT c.company_id,
                             date_trunc('month', first_event.event_time AT TIME ZONE '{TIMEZONE}')::date
                               AS first_month
                      FROM client_company c
                      JOIN LATERAL (
                        SELECT e.event_time FROM {events_table} e
                        WHERE e.company_id = c.company_id
                        ORDER BY e.event_time ASC LIMIT 1
                      ) first_event ON true
                    )
                    SELECT f.company_id FROM first_seen f
                    LEFT JOIN company_activation a ON a.company_id = f.company_id
                    WHERE f.first_month = %(month)s AND {activation_clause}
                    ORDER BY f.company_id
                    """,
                    {"month": month},
                )
                payload = self._overview_slice_payload(company_ids)

            elif chart == "composition":
                if key not in {"new", "returning", "resurrected"}:
                    raise ValueError("invalid composition key")
                month = _exact_date(
                    (params.get("month") or [None])[0], "month", month_start=True
                )
                if key == "new":
                    membership = "f.first_month = %(month)s"
                elif key == "returning":
                    membership = (
                        "f.first_month < %(month)s AND EXISTS ("
                        "SELECT 1 FROM action_months prev"
                        " WHERE prev.distinct_id = active.distinct_id"
                        " AND prev.month = (%(month)s::date - INTERVAL '1 month')::date)"
                    )
                else:
                    membership = (
                        "f.first_month < %(month)s AND NOT EXISTS ("
                        "SELECT 1 FROM action_months prev"
                        " WHERE prev.distinct_id = active.distinct_id"
                        " AND prev.month = (%(month)s::date - INTERVAL '1 month')::date)"
                    )
                pairs = self._overview_slice_pairs(
                    f"""
                    WITH action_months AS (
                      SELECT DISTINCT e.distinct_id,
                             date_trunc('month', e.event_time AT TIME ZONE '{TIMEZONE}')::date AS month
                      FROM {events_table} e
                      WHERE e.event_name = ANY(%(actions)s)
                        AND NOT public.is_internal_email(e.email)
                        AND EXISTS (SELECT 1 FROM client_company c WHERE c.company_id = e.company_id)
                    ), first_action AS (
                      SELECT distinct_id, MIN(month) AS first_month
                      FROM action_months GROUP BY distinct_id
                    ), active AS (
                      SELECT DISTINCT e.company_id, e.distinct_id
                      FROM {events_table} e
                      WHERE e.event_name = ANY(%(actions)s)
                        AND NOT public.is_internal_email(e.email)
                        AND e.distinct_id IS NOT NULL
                        AND EXISTS (SELECT 1 FROM client_company c WHERE c.company_id = e.company_id)
                        AND date_trunc('month', e.event_time AT TIME ZONE '{TIMEZONE}')::date = %(month)s
                    )
                    SELECT active.company_id, active.distinct_id
                    FROM active JOIN first_action f ON f.distinct_id = active.distinct_id
                    WHERE {membership}
                    ORDER BY active.company_id, active.distinct_id
                    """,
                    {"actions": list(ACTION_EVENTS), "month": month},
                )
                payload = self._overview_slice_payload(
                    list(dict.fromkeys(pair[0] for pair in pairs)), pairs
                )

            elif chart == "week8":
                if key not in {"retained", "dropped"}:
                    raise ValueError("invalid week8 key")
                cohort_week = _exact_date(
                    (params.get("cohort_week") or [None])[0], "cohort_week", monday=True
                )
                current_monday = _ist_monday()
                if cohort_week + timedelta(days=63) > current_monday:
                    raise ValueError("cohort_week must be a mature Week-8 cohort")
                if key == "retained":
                    cell = self._cell_payload(cohort_week, 8)
                    payload = {
                        "people_count": cell["people_count"],
                        "company_count": cell["company_count"],
                        "users": cell["users"],
                    }
                else:
                    target_week = cohort_week + timedelta(days=56)
                    company_ids = self._overview_slice_company_ids(
                        "SELECT a.company_id FROM company_activation a"
                        " WHERE a.activation_week = %(cohort)s"
                        " AND NOT EXISTS ("
                        "   SELECT 1 FROM company_week_value v"
                        "   WHERE v.company_id = a.company_id"
                        "     AND v.week_start = %(target)s AND v.had_value"
                        " ) ORDER BY a.company_id",
                        {"cohort": cohort_week, "target": target_week},
                    )
                    payload = self._overview_slice_payload(company_ids)

            elif chart == "growth":
                if key != "companies":
                    raise ValueError("invalid growth key")
                week = _exact_date(
                    (params.get("week") or [None])[0], "week", monday=True
                )
                company_ids = self._overview_slice_company_ids(
                    f"""
                    SELECT c.company_id FROM client_company c
                    JOIN LATERAL (
                      SELECT e.event_time FROM {events_table} e
                      WHERE e.company_id = c.company_id
                      ORDER BY e.event_time ASC LIMIT 1
                    ) first_event ON true
                    WHERE date_trunc('week', first_event.event_time
                      AT TIME ZONE '{TIMEZONE}')::date = %(week)s
                    ORDER BY c.company_id
                    """,
                    {"week": week},
                )
                payload = self._overview_slice_payload(company_ids)

            elif chart == "monthly":
                if key not in {"people", "companies"}:
                    raise ValueError("invalid monthly key")
                month = _exact_date(
                    (params.get("month") or [None])[0], "month", month_start=True
                )
                next_month = _add_months(month, 1)
                pairs = self._overview_slice_pairs(
                    f"""
                    SELECT DISTINCT e.company_id, e.distinct_id FROM {events_table} e
                    WHERE e.event_name = ANY(%(actions)s)
                      AND NOT public.is_internal_email(e.email)
                      AND e.distinct_id IS NOT NULL
                      AND EXISTS (
                        SELECT 1 FROM client_company c WHERE c.company_id = e.company_id
                      )
                      AND e.event_time >= (%(start)s::date AT TIME ZONE '{TIMEZONE}')
                      AND e.event_time < (%(end)s::date AT TIME ZONE '{TIMEZONE}')
                    ORDER BY e.company_id, e.distinct_id
                    """,
                    {"actions": list(ACTION_EVENTS), "start": month, "end": next_month},
                )
                if key == "people":
                    company_ids = list(dict.fromkeys(pair[0] for pair in pairs))
                else:
                    company_ids = self._overview_slice_company_ids(
                        f"""
                        SELECT DISTINCT e.company_id FROM {events_table} e
                        WHERE e.event_name = ANY(%(actions)s)
                          AND EXISTS (
                            SELECT 1 FROM client_company c WHERE c.company_id = e.company_id
                          )
                          AND e.event_time >= (%(start)s::date::timestamp AT TIME ZONE '{TIMEZONE}')
                          AND e.event_time < (%(end)s::date::timestamp AT TIME ZONE '{TIMEZONE}')
                        ORDER BY e.company_id
                        """,
                        {"actions": list(ACTION_EVENTS), "start": month, "end": next_month},
                    )
                payload = self._overview_slice_payload(company_ids, pairs)

            elif chart == "feature":
                if key not in FEATURE_SLICE_KEYS:
                    raise ValueError("invalid feature key")
                granularity = (params.get("period") or ["week"])[0]
                if granularity == "month":
                    start = _exact_date(
                        (params.get("month") or [None])[0], "month", month_start=True
                    )
                    end = _add_months(start, 1)
                    if key.endswith(".sync"):
                        module_key = key.split(".", 1)[0]
                        predicate = (
                            f"e.event_name = 'Accounting Sync' AND EXISTS ("
                            f" SELECT 1 FROM {events_table} pe"
                            f" WHERE pe.company_id = e.company_id"
                            f" AND {_feature_path_predicate(module_key, 'pe')}"
                            ")"
                        )
                    else:
                        predicate = _feature_slice_predicate(key, events_table=events_table)
                    range_params = {"start": start, "end": end}
                    range_sql = (
                        f" AND e.event_time >= (%(start)s::date AT TIME ZONE '{TIMEZONE}')"
                        f" AND e.event_time < (%(end)s::date AT TIME ZONE '{TIMEZONE}')"
                    )
                else:
                    start = _exact_date(
                        (params.get("week") or [None])[0], "week", monday=True
                    )
                    end = start + timedelta(days=7)
                    predicate = _feature_slice_predicate(key, events_table=events_table)
                    range_params = {"week": start}
                    range_sql = (
                        f" AND e.event_time >= (%(week)s::date AT TIME ZONE '{TIMEZONE}')"
                        f" AND e.event_time < ((%(week)s::date + 7) AT TIME ZONE '{TIMEZONE}')"
                    )
                company_ids = self._overview_slice_company_ids(
                    f"SELECT DISTINCT e.company_id FROM {events_table} e"
                    f" WHERE {predicate}"
                    f"{range_sql}"
                    " AND EXISTS ("
                    " SELECT 1 FROM client_company c WHERE c.company_id = e.company_id"
                    ")"
                    " ORDER BY e.company_id",
                    range_params,
                )
                payload = self._overview_slice_payload(company_ids)
                with _db() as conn, conn.cursor() as cur:
                    usage = _feature_usage_payload(cur, events_table, start)
                module_key = key.split(".", 1)[0]
                module = next(
                    item for item in usage["modules"] if item["key"] == module_key
                )
                payload["feature"] = module
                payload["feature_node"] = key if "." in key else None

            elif chart in {"module", "module_usage"}:
                if not key or key.split(".", 1)[0] not in {
                    item["key"] for item in MODULE_USAGE_DEFINITIONS
                }:
                    raise ValueError("invalid module key")
                granularity = (params.get("period") or ["week"])[0]
                if granularity == "month":
                    start = _exact_date(
                        (params.get("month") or [None])[0], "month", month_start=True
                    )
                    end = _add_months(start, 1)
                elif granularity == "week":
                    start = _exact_date(
                        (params.get("week") or [None])[0], "week", monday=True
                    )
                    end = start + timedelta(days=7)
                else:
                    raise ValueError("period must be week or month")
                module_key, stage_key = (key.split(".", 1) + [None])[:2] if "." in key else (key, None)
                definition = _module_definition(module_key)
                valid_stage_keys = {node_key for node_key, _label in definition["nodes"]} if definition else set()
                if stage_key and stage_key not in valid_stage_keys:
                    raise ValueError("invalid module stage")
                property_key = (params.get("property") or [None])[0]
                property_value = (params.get("value") or [None])[0]
                if property_key and property_key not in CHAIN_PROPERTY_KEYS:
                    raise ValueError("invalid module property")
                with _db() as conn, conn.cursor() as cur:
                    cur.execute(
                        f"""
                        SELECT e.company_id, e.event_name, e.event_time, e.properties
                        FROM {events_table} e
                        WHERE EXISTS (
                          SELECT 1 FROM client_company c WHERE c.company_id = e.company_id
                        )
                          AND e.event_time >= (%(start)s::date::timestamp AT TIME ZONE '{TIMEZONE}')
                          AND e.event_time < (%(end)s::date::timestamp AT TIME ZONE '{TIMEZONE}')
                          AND e.event_name = ANY(%(events)s)
                        ORDER BY e.company_id, e.event_time ASC, e.insert_id ASC
                        """,
                        {
                            "start": start,
                            "end": end,
                            "events": list(ACTION_EVENTS),
                        },
                    )
                    rows = cur.fetchall()
                    by_company = defaultdict(list)
                    for company_id, event_name, event_time, properties in rows:
                        by_company[str(company_id)].append(
                            (str(event_name), event_time, properties)
                        )
                    entry_key = definition["entry"] if definition else None
                    selected_ids = []
                    for company_id, company_rows in by_company.items():
                        classified = [
                            (event_time, _module_node_for_event(event_name, properties), properties)
                            for event_name, event_time, properties in company_rows
                        ]
                        entry_times = [
                            event_time for event_time, node, _properties in classified
                            if node == f"{module_key}.{entry_key}"
                        ]
                        entry_time = min(entry_times) if entry_times else None
                        if entry_time is None:
                            continue
                        matches = False
                        for event_time, node, properties in classified:
                            if event_time < entry_time:
                                continue
                            if property_key and property_value is not None:
                                if _module_property_value(properties, property_key) != property_value:
                                    continue
                            if stage_key and node == f"{module_key}.{stage_key}":
                                matches = True
                            elif stage_key == "sync" and node == "sync":
                                matches = True
                            elif stage_key is None and node and (
                                node.startswith(f"{module_key}.")
                                or node == "sync"
                            ):
                                matches = True
                        if matches:
                            selected_ids.append(company_id)
                    module_usage = _module_usage_payload(
                        cur,
                        events_table,
                        start,
                        end,
                        granularity,
                    )
                payload = self._overview_slice_payload(selected_ids)
                module = next(item for item in module_usage["modules"] if item["key"] == module_key)
                stage = next(
                    (item for item in module["stages"] if item["key"] == stage_key),
                    None,
                ) if stage_key else None
                payload["module"] = module
                payload["module_slice"] = {
                    "module_key": module_key,
                    "stage_key": stage_key,
                    "window_start": start.isoformat(),
                    "window_end": end.isoformat(),
                    "stage": stage,
                    "property_breakdown": (
                        stage.get("breakdown", stage.get("property_breakdown", []))
                        if stage else module.get("property_breakdown", [])
                    ),
                }
                payload["module_key"] = module_key
                payload["module_stage"] = stage_key

            elif chart == "product":
                if key not in PRODUCT_SPLIT_KEYS:
                    raise ValueError("invalid product key")
                week = _exact_date(
                    (params.get("week") or [None])[0], "week", monday=True
                )
                company_ids = self._overview_slice_company_ids(
                    "SELECT company_id FROM company_week_product"
                    f" WHERE week_start = %(week)s AND {key}"
                    " ORDER BY company_id",
                    {"week": week},
                )
                payload = self._overview_slice_payload(company_ids)

            else:  # family
                if key not in ACTION_FAMILIES:
                    raise ValueError("invalid family key")
                with _db() as conn, conn.cursor() as cur:
                    _as_of, _week, month_start, next_to_prior = self._overview_stamps(cur)
                next_month_start = _add_months(month_start, 1)
                pairs = self._overview_slice_pairs(
                    f"""
                    SELECT DISTINCT e.company_id, e.distinct_id FROM {events_table} e
                    WHERE e.event_name = ANY(%(family)s)
                      AND NOT public.is_internal_email(e.email)
                      AND e.distinct_id IS NOT NULL
                      AND EXISTS (SELECT 1 FROM client_company c WHERE c.company_id = e.company_id)
                      AND e.event_time >= (%(start)s::date AT TIME ZONE '{TIMEZONE}')
                      AND e.event_time < (%(end)s::date AT TIME ZONE '{TIMEZONE}')
                    ORDER BY e.company_id, e.distinct_id
                    """,
                    {"family": list(ACTION_FAMILIES[key]), "start": month_start, "end": next_month_start},
                )
                payload = self._overview_slice_payload(
                    list(dict.fromkeys(pair[0] for pair in pairs)), pairs
                )
        except ValueError as exc:
            self._bad_request(str(exc))
            return
        except Exception:
            self._send_json(500, {"error": "overview slice unavailable"})
            return
        self._send_json(200, payload)

    def _page_summary(self, query: str = "") -> None:
        """Five Retention cards. Page-level; not tied to a heatmap cell."""
        week_bounds = self._week_filter(query)
        if week_bounds is None:
            return
        from_week, to_week = week_bounds
        try:
            with _db() as conn, conn.cursor() as cur:
                cur.execute("SELECT COUNT(*) FROM client_company")
                client_companies = int(cur.fetchone()[0])
                cur.execute("SELECT COUNT(*) FROM company_activation")
                activated = int(cur.fetchone()[0])
                cur.execute(
                    "SELECT percentile_cont(0.5) WITHIN GROUP ("
                    " ORDER BY EXTRACT(EPOCH FROM"
                    " (first_sync_at - signed_up_at)) / 3600.0)"
                    " FROM company_profile"
                    " WHERE first_sync_at IS NOT NULL"
                    " AND signed_up_at IS NOT NULL"
                )
                median_ttv = cur.fetchone()[0]
                cur.execute(
                    "SELECT COUNT(*) FROM company_activation a"
                    " JOIN company_profile p ON p.company_id = a.company_id"
                    " WHERE p.path_had_recon"
                )
                recon_count = int(cur.fetchone()[0])
                cur.execute(
                    "SELECT DISTINCT cohort_week FROM retention_cells"
                    " WHERE rel_week = 0 AND cohort_week <="
                    " (date_trunc('week',"
                    f" (CURRENT_TIMESTAMP AT TIME ZONE '{TIMEZONE}'))::date)"
                    " ORDER BY cohort_week"
                )
                cohort_weeks = [row[0].isoformat() for row in cur.fetchall()]
                cur.execute(
                    "SELECT cohort_week, cohort_size, retained_count"
                    " FROM retention_cells WHERE rel_week = 8"
                    " AND cohort_week <="
                    " (date_trunc('week',"
                    f" (CURRENT_TIMESTAMP AT TIME ZONE '{TIMEZONE}'))::date"
                    " - 63)"
                    " AND (%(from_week)s::date IS NULL OR cohort_week >= %(from_week)s::date)"
                    " AND (%(to_week)s::date IS NULL OR cohort_week <= %(to_week)s::date)"
                    " ORDER BY cohort_week DESC LIMIT 1",
                    {"from_week": from_week, "to_week": to_week},
                )
                week8 = cur.fetchone()
        except Exception:
            self._send_json(500, {"error": "summary unavailable"})
            return
        activation_rate = (
            activated / client_companies if client_companies else 0.0
        )
        recon_rate = recon_count / activated if activated else 0.0
        if week8 is None:
            week8_week, week8_n, week8_kept = None, 0, 0
            week8_rate = None
        else:
            week8_week, week8_n, week8_kept = week8
            week8_rate = (week8_kept / week8_n) if week8_n else 0.0
            week8_week = week8_week.isoformat()
        median_hours = (
            round(float(median_ttv), 1) if median_ttv is not None else None
        )
        self._send_json(200, {
            "client_companies": client_companies,
            "activated": activated,
            "activation_rate": activation_rate,
            "median_ttv_hours": median_hours,
            "week8_cohort_week": week8_week,
            "week8_cohort_size": week8_n,
            "week8_retained": week8_kept,
            "week8_retention": week8_rate,
            "recon_count": recon_count,
            "recon_among_activated": recon_rate,
            "cohort_weeks": cohort_weeks,
        })

    def _heatmap(self, query: str = "") -> None:
        week_bounds = self._week_filter(query)
        if week_bounds is None:
            return
        from_week, to_week = week_bounds
        try:
            with _db() as conn, conn.cursor() as cur:
                cur.execute(
                    "SELECT cohort_week, rel_week, cohort_size, retained_count"
                    " FROM retention_cells"
                    " WHERE ("
                    " (rel_week = 0 AND cohort_week <="
                    "  date_trunc('week',"
                    f"   (CURRENT_TIMESTAMP AT TIME ZONE '{TIMEZONE}'))::date)"
                    " OR (rel_week BETWEEN 1 AND 8"
                    "  AND cohort_week + (rel_week * 7) + 7 <="
                    "  date_trunc('week',"
                    f"   (CURRENT_TIMESTAMP AT TIME ZONE '{TIMEZONE}'))::date)"
                    " )"
                    " AND (%(from_week)s::date IS NULL OR cohort_week >= %(from_week)s::date)"
                    " AND (%(to_week)s::date IS NULL OR cohort_week <= %(to_week)s::date)"
                    " ORDER BY cohort_week, rel_week",
                    {"from_week": from_week, "to_week": to_week},
                )
                rows = cur.fetchall()
        except Exception:
            self._send_json(500, {"error": "heatmap unavailable"})
            return
        payload = [
            {
                "cohort_week": cohort_week.isoformat(),
                "rel_week": rel_week,
                "cohort_size": cohort_size,
                "retained_count": retained_count,
                "rate": (retained_count / cohort_size)
                if cohort_size
                else 0.0,
            }
            for cohort_week, rel_week, cohort_size, retained_count in rows
        ]
        self._send_json(200, payload)

    def _cell(self, query: str) -> None:
        params = parse_qs(query)
        cohort_raw = (params.get("cohort_week") or [None])[0]
        rel_raw = (params.get("rel_week") or [None])[0]
        try:
            cohort_week = date.fromisoformat(cohort_raw) if cohort_raw else None
        except (ValueError, TypeError):
            cohort_week = None
        if cohort_week is None or cohort_raw != cohort_week.isoformat():
            self._bad_request("cohort_week must be YYYY-MM-DD")
            return
        try:
            rel_week = int(rel_raw) if rel_raw is not None else -1
        except (ValueError, TypeError):
            self._bad_request("rel_week must be an integer 0..8")
            return
        if rel_week < 0 or rel_week > 8:
            self._bad_request("rel_week must be an integer 0..8")
            return
        try:
            payload = self._cell_payload(cohort_week, rel_week)
        except Exception:
            self._send_json(500, {"error": "cell unavailable"})
            return
        self._send_json(200, payload)

    def _summary(self, company_id: str) -> None:
        try:
            events_table = get_events_table()
            with _db() as conn, conn.cursor() as cur:
                cur.execute(
                    "SELECT company_id, company_name, signed_up_at,"
                    " activated_at, activation_week, first_upload_at, first_ready_at,"
                    " first_sync_at, first_recon_at, last_action_at,"
                    " action_count, active_weeks,"
                    " path_had_upload, path_had_ready,"
                    " path_had_sync, path_had_recon"
                    " FROM company_profile WHERE company_id = %s",
                    (company_id,),
                )
                profile = cur.fetchone()
                if profile is None:
                    self._send_json(404, {"error": "unknown company"})
                    return
                (cid, company_name, signed_up_at, activated_at, activation_week,
                 first_upload_at, first_ready_at, first_sync_at,
                 first_recon_at, last_action_at, action_count,
                 active_weeks, path_had_upload, path_had_ready,
                 path_had_sync, path_had_recon) = profile
                cur.execute(
                    "SELECT w.week_start, w.action_count, w.upload_count,"
                    " w.txn_count, w.ap_count, w.sync_count, w.recon_count,"
                    " COALESCE(p.had_bill_upload, false),"
                    " COALESCE(p.had_invoice_upload, false),"
                    " COALESCE(p.had_statement_upload, false),"
                    " COALESCE(p.had_ap_active, false),"
                    " COALESCE(p.had_txn_active, false),"
                    " COALESCE(p.had_gst_recon, false),"
                    " COALESCE(p.had_created_bill_or_txn, false)"
                    " FROM company_week_action w"
                    " LEFT JOIN company_week_product p"
                    "   ON p.company_id = w.company_id"
                    "  AND p.week_start = w.week_start"
                    " WHERE w.company_id = %s"
                    " ORDER BY w.week_start ASC",
                    (company_id,),
                )
                weeks = cur.fetchall()
                cur.execute(
                    f"SELECT MAX(event_time) FILTER (WHERE event_name = 'Accounting Sync'),"
                    " MAX(event_time) FILTER (WHERE event_name = 'Recon Processed')"
                    f" FROM {events_table} WHERE company_id = %s",
                    (company_id,),
                )
                last_sync_at, last_recon_at = cur.fetchone()
                week8_start = (
                    activation_week + timedelta(days=56)
                    if activation_week is not None
                    else None
                )
                cur.execute(
                    "SELECT MAX(week_start) FILTER (WHERE had_value),"
                    " BOOL_OR(had_value) FILTER (WHERE week_start = %s)"
                    " FROM company_week_value WHERE company_id = %s",
                    (week8_start, company_id),
                )
                last_value_week_start, week8_had_value = cur.fetchone()
                detail_event_names = CHAIN_EVENT_NAMES
                cur.execute(
                    f"SELECT event_name, event_time, properties"
                    f" FROM {events_table}"
                    " WHERE company_id = %s AND event_name = ANY(%s)"
                    " ORDER BY event_time ASC, insert_id ASC",
                    (company_id, list(detail_event_names)),
                )
                detail_events = cur.fetchall()
                # One grouped query: lifetime action mix, actions only.
                # Login / Dashboard Viewed / Sign Up never count here.
                cur.execute(
                    f"SELECT event_name, COUNT(*) FROM {events_table}"
                    " WHERE company_id = %s AND event_name = ANY(%s)"
                    " GROUP BY event_name"
                    " ORDER BY COUNT(*) DESC, event_name ASC"
                    f" LIMIT {BY_EVENT_LIMIT}",
                    (company_id, list(ACTION_EVENTS)),
                )
                events = cur.fetchall()
        except Exception:
            self._send_json(500, {"error": "summary unavailable"})
            return
        events_by_name = defaultdict(list)
        for event_name, event_time, properties in detail_events:
            events_by_name[event_name].append((event_time, properties))
        event_chain = build_event_chain(detail_events, scope="lifetime")

        def event_details(event_name):
            rows = events_by_name.get(event_name, [])
            return {
                "event_name": event_name,
                "count": len(rows),
                "first_at": _iso(rows[0][0]) if rows else None,
                "last_at": _iso(rows[-1][0]) if rows else None,
            }

        upload_type_groups = defaultdict(list)
        for event_time, properties in events_by_name.get("Upload", []):
            upload_type_groups[_upload_type(properties)].append(
                (event_time, _is_failed_upload(properties))
            )

        def type_label(value: str) -> str:
            if value == "unknown":
                return "Unknown"
            return value.replace("_", " ").title()

        upload_type_keys = [
            key for key in UPLOAD_TYPE_ORDER if key in upload_type_groups
        ]
        upload_type_keys.extend(sorted(
            key for key in upload_type_groups
            if key not in UPLOAD_TYPE_ORDER
        ))
        upload_types = []
        for key in upload_type_keys:
            rows = upload_type_groups[key]
            upload_types.append({
                "key": key,
                "label": type_label(key),
                "count": len(rows),
                "first_at": _iso(rows[0][0]),
                "last_at": _iso(rows[-1][0]),
                "failed_count": sum(1 for _time, failed in rows if failed),
            })

        ready_activities = [event_details(name) for name in READY_EVENTS]
        ledger_events = [
            event_details(name) for name in LEDGER_EVENTS
            if events_by_name.get(name)
        ]
        transaction_type_groups = defaultdict(list)
        for event_name in LEDGER_EVENTS:
            for event_time, properties in events_by_name.get(event_name, []):
                if not isinstance(properties, dict) or "transactionType" not in properties:
                    continue
                raw_type = properties.get("transactionType")
                if raw_type is None:
                    continue
                transaction_type = str(raw_type).strip().lower()
                if not transaction_type:
                    continue
                if _looks_like_uuid(transaction_type):
                    transaction_type = "other"
                transaction_type_groups[transaction_type].append(event_time)
        ledger_transaction_types = []
        for transaction_type in sorted(transaction_type_groups):
            rows = transaction_type_groups[transaction_type]
            ledger_transaction_types.append({
                "transaction_type": transaction_type,
                "count": len(rows),
                "first_at": _iso(rows[0]),
                "last_at": _iso(rows[-1]),
            })

        first_integration_at = (
            events_by_name[INTEGRATION_EVENT][0][0]
            if events_by_name.get(INTEGRATION_EVENT)
            else None
        )
        ready_count = sum(
            len(events_by_name.get(event_name, []))
            for event_name in READY_EVENTS
        )
        funnel_stages = [
            ("signup", "Signup", signed_up_at, 1 if signed_up_at else 0, []),
            (
                "integration", "Integration status", first_integration_at,
                len(events_by_name.get(INTEGRATION_EVENT, [])), [],
            ),
            (
                "upload", "Upload", first_upload_at,
                len(events_by_name.get("Upload", [])), [
                    {
                        "key": row["key"],
                        "label": row["label"],
                        "count": row["count"],
                    }
                    for row in upload_types
                ],
            ),
            (
                "ready", "Ready", first_ready_at, ready_count, [
                    {
                        "key": name.lower().replace(" ", "_"),
                        "label": name,
                        "count": len(events_by_name.get(name, [])),
                    }
                    for name in READY_EVENTS
                ],
            ),
            (
                "sync", "Accounting Sync", first_sync_at,
                len(events_by_name.get("Accounting Sync", [])), [],
            ),
        ]
        funnel = []
        previous_at = None
        for key, label, first_at, count, breakdown in funnel_stages:
            funnel.append({
                "key": key,
                "label": label,
                "reached": first_at is not None,
                "first_at": _iso(first_at),
                "count": count,
                "gap_hours_from_prev": _duration_hours(previous_at, first_at),
                "breakdown": breakdown,
            })
            previous_at = first_at
        ap_total = sum((row[4] or 0) for row in weeks)
        txn_total = sum((row[3] or 0) for row in weeks)
        upload_total = sum((row[2] or 0) for row in weeks)
        sync_total = sum((row[5] or 0) for row in weeks)
        recon_total = sum((row[6] or 0) for row in weeks)
        if ap_total and txn_total:
            path_type = "both"
        elif ap_total:
            path_type = "ap"
        elif txn_total:
            path_type = "txn"
        else:
            path_type = "neither"
        if last_value_week_start is not None and activation_week is not None:
            last_value_rel_week = (
                last_value_week_start - activation_week
            ).days // 7
        else:
            last_value_rel_week = None
        current_monday = _ist_monday()
        week8_counted = None
        if (
            activation_week is not None
            and activation_week + timedelta(days=63) <= current_monday
        ):
            week8_counted = bool(week8_had_value)
        now = _ist_now()
        self._send_json(200, {
            "company_id": cid,
            "company_name": company_name,
            "signed_up_at": _iso(signed_up_at),
            "activated_at": _iso(activated_at),
            "activation_week": _iso(activation_week),
            "first_upload_at": _iso(first_upload_at),
            "first_ready_at": _iso(first_ready_at),
            "first_sync_at": _iso(first_sync_at),
            "first_recon_at": _iso(first_recon_at),
            "last_action_at": _iso(last_action_at),
            "lifetime_actions": action_count,
            "active_weeks": active_weeks,
            "actions_per_active_week": _per_week(action_count, active_weeks),
            "ttv_hours": _ttv_hours(signed_up_at, first_sync_at),
            "hours_signup_to_upload": _duration_hours(
                signed_up_at, first_upload_at
            ),
            "hours_upload_to_ready": _duration_hours(
                first_upload_at, first_ready_at
            ),
            "hours_ready_to_sync": _duration_hours(
                first_ready_at, first_sync_at
            ),
            "hours_sync_to_recon": _duration_hours(
                first_sync_at, first_recon_at
            ),
            "last_sync_at": _iso(last_sync_at),
            "last_recon_at": _iso(last_recon_at),
            "hours_since_last_sync": _duration_hours(last_sync_at, now),
            "hours_since_last_recon": _duration_hours(last_recon_at, now),
            "path_type": path_type,
            "last_value_week_start": _iso(last_value_week_start),
            "last_value_rel_week": last_value_rel_week,
            "week8_counted": week8_counted,
            "path_had_upload": bool(path_had_upload),
            "path_had_ready": bool(path_had_ready),
            "path_had_sync": bool(path_had_sync),
            "path_had_recon": bool(path_had_recon),
            "funnel": funnel,
            "work_mix": {
                "scope": "lifetime",
                "upload": upload_total,
                "upload_failed": sum(
                    1 for _time, properties in events_by_name.get("Upload", [])
                    if _is_failed_upload(properties)
                ),
                "ap": ap_total,
                "txn": txn_total,
                "sync": sync_total,
                "recon": recon_total,
            },
            "upload_types": upload_types,
            "ready_activities": ready_activities,
            "ledger_events": ledger_events,
            "ledger_transaction_types": ledger_transaction_types,
            "event_chain": event_chain,
            "by_week": [
                {
                    "week_start": week_start.isoformat(),
                    "action_count": action_count_,
                    "upload_count": upload_count,
                    "txn_count": txn_count,
                    "ap_count": ap_count,
                    "sync_count": sync_count,
                    "recon_count": recon_count,
                    "had_bill_upload": bool(had_bill_upload),
                    "had_invoice_upload": bool(had_invoice_upload),
                    "had_statement_upload": bool(had_statement_upload),
                    "had_ap_active": bool(had_ap_active),
                    "had_txn_active": bool(had_txn_active),
                    "had_gst_recon": bool(had_gst_recon),
                    "had_created_bill_or_txn": bool(had_created_bill_or_txn),
                }
                for (week_start, action_count_, upload_count, txn_count,
                     ap_count, sync_count, recon_count,
                     had_bill_upload, had_invoice_upload, had_statement_upload,
                     had_ap_active, had_txn_active, had_gst_recon,
                     had_created_bill_or_txn) in weeks
            ],
            "by_event": [
                {"event_name": name, "count": count}
                for name, count in events
            ],
        })

    def _timeline(self, company_id: str, query: str) -> None:
        params = parse_qs(query)
        limit_raw = (params.get("limit") or ["100"])[0]
        offset_raw = (params.get("offset") or ["0"])[0]
        try:
            limit = int(limit_raw)
        except (ValueError, TypeError):
            self._bad_request("limit must be an integer 1..500")
            return
        try:
            offset = int(offset_raw)
        except (ValueError, TypeError):
            self._bad_request("offset must be a non-negative integer")
            return
        if limit < 1 or offset < 0:
            self._bad_request("limit must be 1..500, offset >= 0")
            return
        if limit > TIMELINE_MAX_LIMIT:
            limit = TIMELINE_MAX_LIMIT
        try:
            events_table = get_events_table()
            with _db() as conn, conn.cursor() as cur:
                # Newest first. Only event_time + event_name; never email
                # or other PII columns. Login/Dashboard may appear here
                # (it is a log) but never in summary by_event totals.
                cur.execute(
                    f"SELECT COUNT(*) FROM {events_table}"
                    " WHERE company_id = %s",
                    (company_id,),
                )
                total = cur.fetchone()[0]
                cur.execute(
                    f"SELECT event_time, event_name FROM {events_table}"
                    " WHERE company_id = %s"
                    " ORDER BY event_time DESC, insert_id DESC"
                    " LIMIT %s OFFSET %s",
                    (company_id, limit, offset),
                )
                rows = cur.fetchall()
        except Exception:
            self._send_json(500, {"error": "timeline unavailable"})
            return
        self._send_json(200, {
            "total": total,
            "limit": limit,
            "offset": offset,
            "events": [
                {
                    "event_time": _iso(event_time),
                    "event_name": event_name,
                }
                for event_time, event_name in rows
            ],
        })

    # -- static files (read-only; API works when web/ is missing) -----------
    def _static(self, path: str) -> None:
        hint = {
            "ok": True,
            "hint": "retention API: GET /health, /api/overview, /api/summary,"
            " /api/heatmap, /api/heatmap/cell,"
            " /api/companies/:id/summary, /api/companies/:id/timeline",
        }
        if not WEB_ROOT.is_dir():
            self._send_json(200 if path == "/" else 404, hint)
            return
        rel = "index.html" if path in ("", "/") else path.lstrip("/")
        target = (WEB_ROOT / rel).resolve()
        try:
            target.relative_to(WEB_ROOT.resolve())
        except ValueError:
            self._send_json(404, {"error": "not found"})
            return
        if target.is_dir():
            target = target / "index.html"
        if not target.is_file():
            if path in ("", "/"):
                self._send_json(200, hint)
            else:
                self._send_json(404, {"error": "not found"})
            return
        content_type, _ = mimetypes.guess_type(str(target))
        data = target.read_bytes()
        self.send_response(200)
        self.send_header(
            "Content-Type", content_type or "application/octet-stream"
        )
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


def create_server(host: str = "127.0.0.1", port: int = 4830):
    return ThreadingHTTPServer((host, port), ApiHandler)


def main() -> int:
    load_env()
    port = int(os.environ.get("PORT", "4830"))
    try:
        with _db() as conn:
            conn.execute("SELECT 1")
    except Exception as exc:  # noqa: BLE001
        print(f"metrics api db warmup failed: {exc}", flush=True)
        return 1
    server = create_server("127.0.0.1", port)
    print(f"metrics api listening on 127.0.0.1:{port}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
