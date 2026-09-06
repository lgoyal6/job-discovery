-- SQL equivalents of every DAX measure in SEMANTIC_MODEL_SPEC.md.
--
-- WHAT THIS PROVES AND WHAT IT DOES NOT. It proves the arithmetic and the
-- denominators are right, because these run against the built warehouse and
-- return numbers. It does NOT prove the DAX compiles, that the relationships
-- behave as described, or that any report renders. No Power BI tool exists on
-- this machine; see the BLOCKED section of the spec.
--
-- Run: warehouse/scripts/powerbi_equivalents.sh

\echo '### M1  Eligible Requisition Universe (the Q1 denominator)'
select count(*) as eligible_requisition_universe
from jm_wh.dim_requisition_current where is_eligible;

\echo '### M2  Eligible Observed by Source / Sole Source / Pct of Universe'
\echo '###     The denominator is FIXED at the universe. This is REMOVEFILTERS(dim_source).'
with universe as (
  select count(*)::numeric as denom from jm_wh.dim_requisition_current where is_eligible
),
per_source as (
  select o.source_name, count(distinct o.canonical_key) as observed_eligible,
         count(distinct o.canonical_key) filter (where c.source_count = 1) as sole_source_eligible
  from jm_wh.int_fetch_observations o
  join jm_wh.dim_requisition_current c using (canonical_key)
  where c.is_eligible
  group by o.source_name
)
select p.source_name, u.denom::int as denominator, p.observed_eligible, p.sole_source_eligible,
       round(100.0 * p.observed_eligible / u.denom, 1) as pct_of_universe_observed
from per_source p cross join universe u
order by p.sole_source_eligible desc, p.observed_eligible desc, p.source_name;

\echo '### M2b THE TRAP the REMOVEFILTERS note is about: denominator shrinking with the filter.'
\echo '###     If the source slicer is allowed to filter the denominator too, every source'
\echo '###     scores 100 percent of itself and the measure says nothing. Shown, not asserted.'
select o.source_name,
       count(distinct o.canonical_key) as numerator,
       count(distinct o.canonical_key) as denominator_if_it_also_filtered,
       round(100.0 * count(distinct o.canonical_key)
             / nullif(count(distinct o.canonical_key), 0), 1) as pct_wrong
from jm_wh.int_fetch_observations o
join jm_wh.dim_requisition_current c using (canonical_key)
where c.is_eligible
group by o.source_name order by o.source_name;

\echo '### M3  Measurable Closures / Censored / Latency Coverage Pct / Median Latency'
with pop as (select * from jm_wh.dim_requisition_current)
select
  count(*) filter (where first_observed_closed_at is not null
                     and last_observed_open_at is not null
                     and first_observed_closed_at > last_observed_open_at) as measurable_closures,
  count(*) filter (where first_observed_closed_at is null)                 as censored_requisitions,
  count(*)                                                                 as population,
  round(100.0 * count(*) filter (where first_observed_closed_at is not null
                     and last_observed_open_at is not null
                     and first_observed_closed_at > last_observed_open_at)
        / nullif(count(*), 0), 1)                                          as latency_coverage_pct
from pop;

select round(percentile_cont(0.5) within group (order by detection_latency_hours)::numeric, 1)
         as median_detection_latency_hrs,
       round(avg(detection_latency_hours), 1) as mean_hrs,
       count(*) as measured_over
from jm_wh.mart_stale_detection_latency;

\echo '### M3b BLANK-not-zero: a family with no measurable closure must return NULL, not 0.'
select c.role_family,
       count(l.canonical_key) as measurable_closures,
       case when count(l.canonical_key) = 0 then null
            else round(percentile_cont(0.5) within group (
                         order by l.detection_latency_hours)::numeric, 1)
       end as median_latency_hrs_blank_if_none
from jm_wh.dim_requisition_current c
left join jm_wh.mart_stale_detection_latency l using (canonical_key)
group by c.role_family order by c.role_family;

\echo '### M4  Requirement recurrence: denominator is documented requisitions, not the family'
select role_family, family_requisitions_total, family_requisitions_with_requirements as denominator,
       family_text_coverage_pct, requirement, requisitions_naming_it as numerator,
       pct_of_covered_requisitions as recurrence_pct
from jm_wh.mart_requirement_recurrence
where requisitions_naming_it >= 2
order by role_family, requisitions_naming_it desc, requirement;

\echo '### M4b The same numbers divided by the WRONG denominator (the whole family),'
\echo '###     which is what a drag-and-drop percentage would produce.'
select role_family, requirement, requisitions_naming_it as numerator,
       family_requisitions_with_requirements as right_denominator,
       family_requisitions_total              as wrong_denominator,
       pct_of_covered_requisitions            as right_pct,
       round(100.0 * requisitions_naming_it / nullif(family_requisitions_total,0), 1) as wrong_pct
from jm_wh.mart_requirement_recurrence
where family_requisitions_with_requirements <> family_requisitions_total
order by role_family, requirement;

\echo '### M5  UNKNOWN is a value, not an absence: it stays eligible.'
select sponsorship_status, count(*) as requisitions,
       count(*) filter (where is_eligible) as of_which_eligible
from jm_wh.dim_requisition_current group by sponsorship_status order by sponsorship_status;

\echo '### M6  Tracker flags, named for what they are'
select role_family, eligible_requisitions as denominator,
       flagged_applied, flagged_rejected, pct_flagged_applied_or_later
from jm_wh.mart_application_funnel order by role_family;
