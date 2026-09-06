{{
  config(
    materialized       = 'incremental',
    unique_key         = 'source_day_key',
    incremental_strategy = 'delete+insert',
    on_schema_change   = 'fail'
  )
}}

-- depends_on: {{ ref('stg_source_observations') }}

-- MISTAKE 2, KEPT RUNNABLE. Do not ship this. It is the version of
-- fct_source_observation_day that processes only observation dates newer than
-- the newest date it has already built.
--
-- This one survives a correct upstream cursor. Fix the staging model, and the
-- day-2 correction is now sitting in staging, fully visible, and this model
-- still never reads it, because day 2 is not greater than day 6. The number for
-- day 2 was computed once and is never revisited. It is not stale in a way
-- anything reports; it is just wrong and quiet.
--
-- Appending new partitions is only equivalent to incremental processing if the
-- past is immutable. In a warehouse fed by external sources, the past is not
-- immutable. It is only unwatched.
--
-- Swap it in with: scripts/swap.sh naive

with observations as (

    select * from {{ ref('int_fetch_observations') }}

    {% if is_incremental() %}
    where observation_date > (
      select coalesce(max(observation_date), '-infinity'::date) from {{ this }}
    )
    {% endif %}

)

select
    source_name || '|' || observation_date::text          as source_day_key,
    source_name,
    observation_date,
    count(*)                                             as observation_count,
    count(distinct canonical_key)                        as requisition_count,
    count(distinct canonical_key) filter (where is_eligible)
                                                         as eligible_requisition_count,
    count(*) filter (where posting_status = 'OPEN')      as open_observation_count,
    count(*) filter (where posting_status = 'CLOSED')    as closed_observation_count,
    count(*) filter (where requirements <> '')           as observations_with_requirements,
    count(*) filter (where is_late_arriving)             as late_arriving_observation_count,
    count(*) filter (where was_restated)                 as restated_fetch_count,
    min(observed_at)                                     as first_observed_at,
    max(observed_at)                                     as last_observed_at,
    max(ingested_at)                                     as source_high_watermark
from observations
group by source_name, observation_date
