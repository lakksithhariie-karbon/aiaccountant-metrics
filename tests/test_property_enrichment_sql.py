from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def test_property_enrichment_migration_is_allowlisted_and_merge_only():
    sql = (
        ROOT / "supabase/migrations/010_property_enrichment_ingest.sql"
    ).read_text()
    assert "normalize_event_properties" in sql
    assert "merge_event_properties" in sql
    assert "upsert_mixpanel_events_detail" in sql
    assert "ON CONFLICT (insert_id) DO NOTHING" in sql
    assert "SET properties = public.merge_event_properties" in sql
    assert "event_name" in sql and "event_time" in sql
    assert "SET event_name" not in sql
    assert "SET event_time" not in sql
    assert "SET company_id" not in sql
    assert "fileName" not in sql
    assert "gstin" not in sql
    assert "sync_items" not in sql


def test_property_enrichment_migration_keeps_anon_and_authenticated_out():
    sql = (
        ROOT / "supabase/migrations/010_property_enrichment_ingest.sql"
    ).read_text()
    assert "REVOKE ALL ON FUNCTION public.upsert_mixpanel_events_detail" in sql
    assert "REVOKE ALL ON FUNCTION public.upsert_mixpanel_events(jsonb)" in sql
    assert "GRANT EXECUTE ON FUNCTION public.upsert_mixpanel_events_detail" in sql


def test_subtype_missing_fix_is_a_follow_on_migration():
    sql = (ROOT / "supabase/migrations/011_property_subtype_missing.sql").read_text()
    assert "CREATE OR REPLACE FUNCTION public.normalize_event_properties" in sql
    assert "value := NULLIF(btrim(p_properties->>'subType'), '');" in sql
    assert "IF value IS NOT NULL THEN" in sql
    assert "normalized := 'bank';" in sql
