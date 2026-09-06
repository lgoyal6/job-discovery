{{ config(materialized = 'view') }}

-- The current version of each requisition, plus the observation-derived facts
-- that are not part of its identity: when it was first and last seen, by whom,
-- and whether anything has yet observed it closed.
--
-- Identity, raw content and user status stay in three separate models. This one
-- joins nothing from the application tracker on purpose: whether the applicant
-- ticked a box has no business editing what the requisition is.

with current_version as (
    select * from {{ ref('dim_requisition_version') }} where is_current_version
),

observation_facts as (
    select
        canonical_key,
        count(*)                                     as observation_count,
        count(distinct source_name)                  as source_count,
        min(observed_at)                             as first_observed_at,
        max(observed_at)                             as last_observed_at,
        min(ingested_at)                             as first_ingested_at,
        max(ingested_at)                             as last_ingested_at,
        min(posted_at)                               as earliest_claimed_posted_at,
        min(observed_at) filter (where posting_status = 'CLOSED') as first_observed_closed_at,
        max(observed_at) filter (where posting_status = 'OPEN')   as last_observed_open_at,
        count(*) filter (where is_late_arriving)     as late_arriving_observation_count
    from {{ ref('int_fetch_observations') }}
    group by canonical_key
)

select
    v.canonical_key,
    v.version_seq            as current_version_seq,
    v.company,
    v.title,
    v.location,
    v.cycle,
    v.category               as role_family,
    v.graduation_eligible,
    v.sponsorship_status,
    v.is_eligible,
    f.observation_count,
    f.source_count,
    f.first_observed_at,
    f.last_observed_at,
    f.first_ingested_at,
    f.last_ingested_at,
    f.earliest_claimed_posted_at,
    f.first_observed_closed_at,
    f.last_observed_open_at,
    f.late_arriving_observation_count,
    (f.first_observed_closed_at is not null) as has_been_observed_closed
from current_version v
join observation_facts f using (canonical_key)
