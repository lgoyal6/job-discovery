{{ config(materialized = 'table') }}

-- QUESTION 1: which sources yield unique eligible roles?
--
-- DENOMINATOR, stated once and used by every rate below:
--   eligible_requisition_universe = the number of DISTINCT canonical
--   requisitions in the whole window whose current version is eligible.
--   Eligible means the graduation window the posting names admits the applicant
--   AND the posting does not state it will not sponsor. Counted per requisition,
--   never per observation: a source that polls hourly is not more productive
--   than one that polls daily, it is just louder.
--
-- Three numerators, because "yield" is three different claims:
--   observed_eligible   this source saw it at all
--   sole_source_eligible no other source ever saw it. Drop this source and the
--                        requisition is not in the warehouse.
--   first_observer_eligible this source saw it before any other. Not unique,
--                        but it is where the lead time comes from.
--
-- WHAT THIS CANNOT SAY. It measures what reached the warehouse, not what exists.
-- A requisition no source carried is invisible here and always will be, so this
-- ranks sources against each other and not against the market.

with universe as (
    select count(*) as eligible_requisition_universe
    from {{ ref('dim_requisition_current') }}
    where is_eligible
),

eligible_requisitions as (
    select canonical_key, role_family
    from {{ ref('dim_requisition_current') }}
    where is_eligible
),

per_source as (
    select
        o.source_name,
        o.canonical_key,
        min(o.observed_at) as source_first_observed_at
    from {{ ref('int_fetch_observations') }} o
    join eligible_requisitions e using (canonical_key)
    group by o.source_name, o.canonical_key
),

coverage as (
    select
        canonical_key,
        count(distinct source_name) as covering_source_count,
        min(source_first_observed_at) as earliest_observation_at
    from per_source
    group by canonical_key
),

scored as (
    select
        p.source_name,
        p.canonical_key,
        (c.covering_source_count = 1)                                as is_sole_source,
        (p.source_first_observed_at = c.earliest_observation_at)      as is_first_observer,
        extract(epoch from (
            p.source_first_observed_at - c.earliest_observation_at
        )) / 3600.0                                                   as hours_behind_first
    from per_source p
    join coverage c using (canonical_key)
)

select
    s.source_name,
    u.eligible_requisition_universe,
    count(*)                                          as observed_eligible,
    count(*) filter (where s.is_sole_source)          as sole_source_eligible,
    count(*) filter (where s.is_first_observer)       as first_observer_eligible,
    round(100.0 * count(*) / nullif(u.eligible_requisition_universe, 0), 1)
                                                      as pct_of_eligible_universe_observed,
    round(100.0 * count(*) filter (where s.is_sole_source)
          / nullif(u.eligible_requisition_universe, 0), 1)
                                                      as pct_of_eligible_universe_sole_source,
    round(avg(s.hours_behind_first)::numeric, 1)      as avg_hours_behind_first_observer
from scored s
cross join universe u
group by s.source_name, u.eligible_requisition_universe
order by sole_source_eligible desc, observed_eligible desc, s.source_name
