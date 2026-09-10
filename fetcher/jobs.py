from __future__ import annotations

import json
import logging
from collections.abc import Callable
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone

from fetcher.export_client import ExportClient, needs_split
from fetcher.known_events import KNOWN_EVENTS
from fetcher.load import (
    get_watermark,
    set_watermark,
    upsert_events_with_stats,
)
from fetcher.parse import parse_jsonl

log = logging.getLogger("fetcher")

SECONDS_PER_HOUR = 3600
DEFAULT_REQUEST_GAP_SECONDS = 120


class DayTooLargeError(Exception):
    pass


@dataclass(frozen=True)
class DayResult:
    day: date
    rows: int
    inserted: int
    event_names: list[str]
    pct_company_id: float
    pct_real_insert_id: float
    synthesized: int
    request_count: int
    split: bool
    rate_limit_hits: int
    identity_mismatches: int = 0


class RequestPacer:
    def __init__(self, sleep: Callable[[float], None], gap_seconds: float) -> None:
        self._sleep = sleep
        self.gap_seconds = gap_seconds
        self._armed = False

    def before_request(self) -> None:
        if self._armed and self.gap_seconds > 0:
            self._sleep(self.gap_seconds)
        self._armed = True


def six_hour_windows(day: date) -> list[str]:
    start = datetime(day.year, day.month, day.day, tzinfo=timezone.utc)
    windows: list[str] = []
    for offset in range(0, 24, 6):
        lo = int((start + timedelta(hours=offset)).timestamp())
        hi = int((start + timedelta(hours=offset + 6)).timestamp())
        windows.append(f'properties["time"]>={lo} and properties["time"]<{hi}')
    return windows


def _event_names_from_jsonl(text: str) -> set[str]:
    names: set[str] = set()
    for line in text.splitlines():
        if not line.strip():
            continue
        try:
            payload = json.loads(line)
        except json.JSONDecodeError:
            continue
        name = payload.get("event")
        if name:
            names.add(str(name))
    return names


def _pct(part: int, whole: int) -> float:
    if whole == 0:
        return 0.0
    return (part / whole) * 100.0


def _export(
    client: ExportClient,
    pacer: RequestPacer,
    day: date,
    event_names: list[str] | None = None,
    where: str | None = None,
) -> str:
    pacer.before_request()
    return client.export_day(day, event_names=event_names, where=where)


def _export_event_day(
    client: ExportClient,
    pacer: RequestPacer,
    day: date,
    event_name: str,
) -> str:
    chunk = _export(client, pacer, day, event_names=[event_name])
    if not needs_split(chunk):
        return chunk
    pieces: list[str] = []
    for where in six_hour_windows(day):
        piece = _export(
            client, pacer, day, event_names=[event_name], where=where
        )
        if needs_split(piece):
            raise DayTooLargeError(
                f"{day.isoformat()} event {event_name} still over 100k in a 6-hour window"
            )
        if piece.strip():
            pieces.append(piece)
    return "\n".join(pieces)


def load_day(
    client: ExportClient,
    conn,
    day: date,
    sleep: Callable[[float], None],
    request_gap_seconds: float = DEFAULT_REQUEST_GAP_SECONDS,
    pacer: RequestPacer | None = None,
) -> DayResult:
    pacer = pacer or RequestPacer(sleep, request_gap_seconds)
    requests_before = client.request_count
    rate_before = client.rate_limit_hits
    split = False
    jsonl = _export(client, pacer, day)
    if needs_split(jsonl):
        split = True
        names = list(KNOWN_EVENTS)
        for name in sorted(_event_names_from_jsonl(jsonl)):
            if name not in names:
                names.append(name)
        chunks = [
            _export_event_day(client, pacer, day, name) for name in names
        ]
        jsonl = "\n".join(chunk for chunk in chunks if chunk.strip())
    rows, stats = parse_jsonl(jsonl)
    upsert_stats = upsert_events_with_stats(conn, rows)
    inserted = upsert_stats.inserted
    event_names = sorted({row.event_name for row in rows})
    result = DayResult(
        day=day,
        rows=len(rows),
        inserted=inserted,
        event_names=event_names,
        pct_company_id=_pct(stats.with_company_id, len(rows)),
        pct_real_insert_id=_pct(stats.with_real_insert_id, len(rows)),
        synthesized=stats.synthesized_insert_ids,
        request_count=client.request_count - requests_before,
        split=split,
        rate_limit_hits=client.rate_limit_hits - rate_before,
        identity_mismatches=upsert_stats.identity_mismatches,
    )
    log.info(
        "day=%s rows=%s inserted=%s events=%s company_id_pct=%.1f "
        "real_insert_id_pct=%.1f synthesized=%s requests=%s 429s=%s "
        "identity_mismatches=%s split=%s",
        result.day.isoformat(),
        result.rows,
        result.inserted,
        len(result.event_names),
        result.pct_company_id,
        result.pct_real_insert_id,
        result.synthesized,
        result.request_count,
        result.rate_limit_hits,
        result.identity_mismatches,
        result.split,
    )
    return result


def prove_day(
    client: ExportClient,
    conn,
    day: date,
    sleep: Callable[[float], None],
    request_gap_seconds: float = DEFAULT_REQUEST_GAP_SECONDS,
) -> tuple[DayResult, DayResult]:
    pacer = RequestPacer(sleep, request_gap_seconds)
    first = load_day(
        client,
        conn,
        day,
        sleep=sleep,
        request_gap_seconds=request_gap_seconds,
        pacer=pacer,
    )
    second = load_day(
        client,
        conn,
        day,
        sleep=sleep,
        request_gap_seconds=request_gap_seconds,
        pacer=pacer,
    )
    return first, second


def _each_day(start: date, end: date):
    day = start
    while day <= end:
        yield day
        day += timedelta(days=1)


def backfill(
    client: ExportClient,
    conn,
    start: date,
    end: date,
    sleep: Callable[[float], None],
    request_gap_seconds: float = DEFAULT_REQUEST_GAP_SECONDS,
) -> None:
    pacer = RequestPacer(sleep, request_gap_seconds)
    last_ok: date | None = None
    try:
        for day in _each_day(start, end):
            load_day(
                client,
                conn,
                day,
                sleep=sleep,
                request_gap_seconds=request_gap_seconds,
                pacer=pacer,
            )
            last_ok = day
            set_watermark(conn, "backfill", day, "ok")
    except Exception as err:
        set_watermark(
            conn,
            "backfill",
            last_ok,
            "failed",
            detail=str(err),
        )
        raise


def incremental(
    client: ExportClient,
    conn,
    today: date,
    sleep: Callable[[float], None],
    request_gap_seconds: float = DEFAULT_REQUEST_GAP_SECONDS,
) -> None:
    yesterday = today - timedelta(days=1)
    pacer = RequestPacer(sleep, request_gap_seconds)
    previous = get_watermark(conn, "incremental")
    try:
        load_day(
            client,
            conn,
            yesterday,
            sleep=sleep,
            request_gap_seconds=request_gap_seconds,
            pacer=pacer,
        )
        load_day(
            client,
            conn,
            today,
            sleep=sleep,
            request_gap_seconds=request_gap_seconds,
            pacer=pacer,
        )
        set_watermark(conn, "incremental", today, "ok")
    except Exception as err:
        set_watermark(
            conn,
            "incremental",
            previous,
            "failed",
            detail=str(err),
        )
        raise
