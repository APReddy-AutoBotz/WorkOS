-- pg_restore loads data with an empty search_path. These CHECK validators call
-- other WorkOS functions. Resolve built-ins and application helpers consistently.
alter function public.valid_workforce_capabilities(jsonb) set search_path = pg_catalog, public, pg_temp;
alter function public.valid_resource_demand(jsonb) set search_path = pg_catalog, public, pg_temp;
alter function public.valid_capacity_profile(jsonb) set search_path = pg_catalog, public, pg_temp;
alter function public.valid_work_category_catalog(jsonb) set search_path = pg_catalog, public, pg_temp;
alter function public.valid_work_period_notice_definition(jsonb) set search_path = pg_catalog, public, pg_temp;
alter function public.valid_assignment_approval_definition(jsonb) set search_path = pg_catalog, public, pg_temp;
alter function public.valid_commercial_approval_definition(jsonb) set search_path = pg_catalog, public, pg_temp;
alter function public.valid_governed_tm_policy(jsonb) set search_path = pg_catalog, public, pg_temp;
alter function public.valid_tm_billing_eligibility_policy(jsonb) set search_path = pg_catalog, public, pg_temp;
alter function public.valid_invoice_batch_approval_policy(jsonb) set search_path = pg_catalog, public, pg_temp;
alter function public.valid_invoice_export_notice_policy(jsonb) set search_path = pg_catalog, public, pg_temp;
alter function public.valid_invoice_action_template(jsonb) set search_path = pg_catalog, public, pg_temp;
alter function public.valid_milestone_billing_policy(jsonb) set search_path = pg_catalog, public, pg_temp;
