{{
  config(
    materialized       = 'incremental',
    unique_key         = 'observation_id',
    incremental_strategy = 'delete+insert',
    on_schema_change   = 'fail'
  )
}}

-- MISTAKE 1, KEPT RUNNABLE. Do not ship this. It is the version of
-- stg_source_observations whose cursor reads the observation clock.
--
-- It looks right, and that is the problem. observed_at is the timestamp the row
-- is about, it is monotonic across normal runs, and it produces correct results
-- for as long as nothing is ever corrected. The moment a fetch from day 2 is
-- restated on day 7, its observed_at is still day 2, the cursor is sitting at
-- day 6, and the row is filtered out. Not delayed. Filtered out, permanently,
-- on this run and every future run, because the cursor only moves forward.
--
-- Swap it in with: scripts/swap.sh naive

with landed as (

    select * from {{ source('raw', 'source_observations') }}

    {% if is_incremental() %}
    where observed_at > (
      select coalesce(max(observed_at), '-infinity'::timestamptz) from {{ this }}
    )
    {% endif %}

)

select
    observation_id,
    batch_id,
    source_name,
    source_job_id,
    revision,
    {{ source_rank('source_name') }}                       as source_rank,
    posted_at,
    observed_at,
    ingested_at,
    observed_at::date                                      as observation_date,
    nullif(corrects_observation_id, '')                    as corrects_observation_id,
    nullif(correction_reason, '')                          as correction_reason,
    (revision > 1 or corrects_observation_id <> ''
       or observed_at < ingested_at - interval '1 day')     as is_late_arriving,
    company,
    title,
    location,
    cycle,
    category,
    posting_status,
    sponsorship_status,
    graduation_eligible,
    {{ is_eligible('graduation_eligible', 'sponsorship_status') }} as is_eligible,
    requirements,
    source_url,
    {{ canonical_key('company', 'title', 'cycle') }}        as canonical_key,
    {{ material_fingerprint('title', 'location', 'cycle') }} as material_fingerprint

from landed
