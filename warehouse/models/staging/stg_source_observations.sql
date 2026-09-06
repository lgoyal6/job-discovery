{{
  config(
    materialized       = 'incremental',
    unique_key         = 'observation_id',
    incremental_strategy = 'delete+insert',
    on_schema_change   = 'fail'
  )
}}

-- GRAIN: one landed observation record. One row per (source, source_job_id,
-- observed_at, revision). Restatements sit beside the reading they correct;
-- neither overwrites the other.
--
-- THE CURSOR IS THE INGESTION CLOCK, AND THAT IS THE ENTIRE POINT.
--
-- The obvious filter here is `observed_at > (select max(observed_at) from this)`,
-- because observed_at is what the row is about. It is also wrong. A correction
-- to a day-2 fetch carries observed_at = day 2 forever, so an observed_at
-- cursor sitting at day 6 will never let it in, on this run or any future one.
-- The row is not late by its own clock; it is late by ours. Only ingested_at
-- rises monotonically with arrival, so only ingested_at is a safe cursor.
--
-- demo/naive/stg_source_observations.sql is the observed_at version, kept so
-- the failure can be reproduced rather than described.

with landed as (

    select * from {{ source('raw', 'source_observations') }}

    {% if is_incremental() %}
    where ingested_at > (
      select coalesce(max(ingested_at), '-infinity'::timestamptz) from {{ this }}
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

    -- Three clocks, three columns. Collapsing any two of them is how a
    -- warehouse starts lying about when it knew something.
    posted_at,                                             -- employer's claim
    observed_at,                                           -- when a fetch saw it
    ingested_at,                                           -- when we received it
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
