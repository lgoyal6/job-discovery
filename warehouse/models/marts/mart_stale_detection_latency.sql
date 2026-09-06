{{ config(materialized = 'table') }}

-- QUESTION 2: how quickly are stale listings detected?
--
-- DEFINITION. Detection latency is measured on the observation clock only:
--   first_observed_closed_at  minus  last_observed_open_at
-- It is the width of the window in which the requisition was already closed and
-- the warehouse still believed it was open. It is an UPPER BOUND on ignorance,
-- not a measure of how long the employer had it closed: nothing here knows when
-- the employer actually closed it, only when a fetch first came back saying so.
--
-- DENOMINATOR, stated explicitly:
--   requisitions that have BOTH an observation with status OPEN and a later
--   observation with status CLOSED. Everything else is excluded, and each
--   exclusion is counted in mart_stale_detection_coverage so the denominator is
--   never silently smaller than the population.
--
-- THE CENSORING, said out loud. Requisitions still open at the end of the
-- window have no closure to time and are excluded. They are not excluded at
-- random: a posting that stays open is a posting whose closure would have been
-- detected late or not at all. So this number is measured on the subset most
-- favourable to it and the true latency is worse. A single window cannot fix
-- that; only a longer window can.

with closures as (
    select
        c.canonical_key,
        c.company,
        c.title,
        c.role_family,
        c.source_count,
        c.observation_count,
        c.last_observed_open_at,
        c.first_observed_closed_at,
        extract(epoch from (
            c.first_observed_closed_at - c.last_observed_open_at
        )) / 3600.0 as detection_latency_hours
    from {{ ref('dim_requisition_current') }} c
    where c.first_observed_closed_at is not null
      and c.last_observed_open_at is not null
      and c.first_observed_closed_at > c.last_observed_open_at
),

detecting_source as (
    -- Which source came back with CLOSED first. Credit goes to the fetch, not
    -- to the source that happened to be polling most often.
    select distinct on (o.canonical_key)
        o.canonical_key,
        o.source_name as detected_by_source,
        o.observed_at as detected_at
    from {{ ref('int_fetch_observations') }} o
    where o.posting_status = 'CLOSED'
    order by o.canonical_key, o.observed_at, o.source_name
)

select
    c.canonical_key,
    c.company,
    c.title,
    c.role_family,
    c.source_count,
    c.observation_count,
    c.last_observed_open_at,
    c.first_observed_closed_at,
    d.detected_by_source,
    round(c.detection_latency_hours::numeric, 1) as detection_latency_hours
from closures c
left join detecting_source d using (canonical_key)
order by detection_latency_hours desc
