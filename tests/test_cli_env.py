from datetime import date


def test_cli_main_prove_day_uses_env(monkeypatch, capsys):
    from fetcher import cli

    called = {}

    class FakeClient:
        pass

    class FakeConn:
        def close(self):
            called["closed"] = True

    def fake_client_from_env():
        return FakeClient()

    def fake_connect(_url):
        return FakeConn()

    def fake_prove(client, conn, day, sleep=None, request_gap_seconds=120):
        called["client"] = client
        called["conn"] = conn
        called["day"] = day
        from types import SimpleNamespace

        stats = SimpleNamespace(
            day=day,
            rows=3,
            inserted=3,
            event_names=["Login"],
            pct_company_id=100.0,
            pct_real_insert_id=66.7,
            synthesized=1,
            request_count=1,
            split=False,
            rate_limit_hits=0,
        )
        second = SimpleNamespace(
            day=day,
            rows=3,
            inserted=0,
            event_names=["Login"],
            pct_company_id=100.0,
            pct_real_insert_id=66.7,
            synthesized=1,
            request_count=2,
            split=False,
            rate_limit_hits=0,
        )
        return stats, second

    monkeypatch.setenv("MIXPANEL_PROJECT_ID", "3490984")
    monkeypatch.setenv("MIXPANEL_SA_USERNAME", "sa")
    monkeypatch.setenv("MIXPANEL_SA_SECRET", "secret")
    monkeypatch.setenv("SUPABASE_DB_URL", "postgresql://example")
    monkeypatch.setattr(cli, "client_from_env", fake_client_from_env)
    monkeypatch.setattr(cli, "connect", fake_connect)
    monkeypatch.setattr(cli, "prove_day", fake_prove)

    exit_code = cli.main(["prove-day", "--date", "2026-09-03"])
    assert exit_code == 0
    assert called["day"] == date(2026, 9, 3)
    out = capsys.readouterr().out
    assert "rows=3" in out
    assert "inserted=0" in out
