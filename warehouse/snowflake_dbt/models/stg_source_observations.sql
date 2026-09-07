{{
  config(
    materialized='incremental',
    unique_key='observation_id',
    incremental_strategy='merge'
  )
}}

with landed as (
  select *
  from {{ ref('source_observations') }}
  where batch_id <= {{ var('max_batch', 999999) }}
  {% if is_incremental() %}
    and ingested_at > (select coalesce(max(ingested_at), '1900-01-01'::timestamp_tz) from {{ this }})
  {% endif %}
)

select
  observation_id,
  batch_id,
  source_name,
  source_job_id,
  revision,
  observed_at,
  posted_at,
  ingested_at,
  nullif(corrects_observation_id, '') as corrects_observation_id,
  nullif(correction_reason, '') as correction_reason,
  company,
  title,
  location,
  cycle,
  category,
  posting_status,
  sponsorship_status,
  graduation_eligible,
  requirements,
  source_url,
  regexp_replace(lower(company), '[^a-z0-9]+', '') || '::' ||
    regexp_replace(lower(title), '[^a-z0-9]+', '') || '::' ||
    regexp_replace(lower(cycle), '[^a-z0-9]+', '') as canonical_key,
  to_date(observed_at) as observation_date,
  (revision > 1 or nullif(corrects_observation_id, '') is not null or
    observed_at < dateadd(day, -1, ingested_at)) as is_late_arriving
from landed
