from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def test_pro_grants_migration_keeps_lift_and_shift_schema():
    sql = (ROOT / "supabase/migrations/008_fetcher_grants_and_rls.sql").read_text()
    assert "public.events" in sql
    assert "public.export_watermarks" in sql
    assert "DISABLE ROW LEVEL SECURITY" in sql
    assert "product_metrics_fetcher" in sql
    assert "company_name" not in sql


def test_cron_migration_has_no_free_hostname_and_requires_vault_url():
    sql = (ROOT / "supabase/migrations/009_cron_url_from_vault.sql").read_text()
    assert "vphqalgyudaayzswtkac" not in sql
    assert "sync_incremental_function_url" in sql
    assert "sync_incremental_service_role" in sql
    assert "sync_incremental_cron" in sql
    assert "timeout_milliseconds := 150000" in sql
