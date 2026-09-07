{{ config(materialized='view') }}

with ranked as (
  select
    *,
    row_number() over (
      partition by canonical_key
      order by observed_at desc, revision desc, ingested_at desc
    ) as current_rank,
    count(*) over (partition by canonical_key) as observation_count,
    count(distinct source_name) over (partition by canonical_key) as source_count,
    min(posted_at) over (partition by canonical_key) as earliest_claimed_posted_at,
    min(iff(posting_status = 'CLOSED', observed_at, null)) over
      (partition by canonical_key) as first_observed_closed_at,
    max(iff(posting_status = 'OPEN', observed_at, null)) over
      (partition by canonical_key) as last_observed_open_at
  from {{ ref('stg_source_observations') }}
)
select
  canonical_key,
  company,
  title,
  location,
  cycle,
  category as role_family,
  graduation_eligible,
  sponsorship_status,
  graduation_eligible and sponsorship_status <> 'UNSUPPORTED' as is_eligible,
  observation_count,
  source_count,
  earliest_claimed_posted_at,
  first_observed_closed_at,
  last_observed_open_at
from ranked
where current_rank = 1
