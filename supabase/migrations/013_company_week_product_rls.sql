-- 013_company_week_product_rls.sql
--
-- Match the existing warehouse derived tables. The fetcher role reads this
-- materialized table through the API and the refresh RPC owns its rebuild.

ALTER TABLE public.company_week_product DISABLE ROW LEVEL SECURITY;
