{{
  config(
    materialized       = 'incremental',
    unique_key         = 'source_day_key',
    incremental_strategy = 'delete+insert',
    on_schema_change   = 'fail'
  )
}}

-- depends_on: {{ ref('stg_source_observations') }}
--   The ref above is otherwise only reachable inside the is_incremental block,
--   and dbt builds its DAG by static analysis, so it has to be declared here or
--   this model can be scheduled before the staging table it reads.

-- GRAIN: one row per (source_name, observation_date).
--
-- This is the model the whole exercise is about, because it is the shape that
-- breaks. It is keyed on the observation clock and built incrementally, and a
-- correction arrives with an old observation date and a new ingestion time. Two
-- separate mistakes will each silently produce a wrong number here, and fixing
-- one does not fix the other.
--
-- MISTAKE 1, upstream: cursor on observed_at. The correction never enters
-- staging, so nothing downstream can be right. Fixed in
-- stg_source_observations by cursoring on ingested_at.
--
-- MISTAKE 2, here: process only dates after the newest date already built. The
-- correction is now sitting in staging, and this model still never looks at
-- day 2 again, because day 2 is not after day 6. Appending new dates is not
-- incremental processing; it is incremental appending, and it is only correct
-- if the past is immutable. The past is not immutable. It is just quiet.
--
-- THE FIX, below: find the earliest observation date touched by anything
-- ingested since this model's own high-water mark, and reprocess every date
-- from there forward. delete+insert on (source_name, observation_date) then
-- replaces those days wholesale rather than adding to them. The interval is
-- bounded by the data, so an ordinary run with no corrections reprocesses one
-- day and a run carrying a five-day-old correction reprocesses five.
--
-- NEGATIVE CONTROL 1, KEPT RUNNABLE. Do not ship this.
-- One word differs from the shipped model: the affected interval start is
-- computed from min(ingested_at) instead of min(observed_at). It compiles, it
-- runs, it reprocesses an interval, and it produces exactly the same number of
-- rows as the correct model. It is also wrong, because a correction ingested on
-- day 7 makes the interval start on day 7, and the day it actually belongs to
-- is day 2. Row counts cannot detect this. Only a value-level comparison can.

{% if is_incremental() %}
-- The earliest observation date any newly ingested row belongs to. Evaluated
-- against staging rather than this model so that corrections, which by
-- definition have old observation dates, still widen the interval.
{% set affected_interval_start %}
  (
    select coalesce(min(s.ingested_at)::date, current_date)
    from {{ ref('stg_source_observations') }} s
    where s.ingested_at > (
      select coalesce(max(f.source_high_watermark), '-infinity'::timestamptz) from {{ this }} f
    )
  )
{% endset %}
{% endif %}

with observations as (

    select * from {{ ref('int_fetch_observations') }}

    {% if is_incremental() %}
    where observation_date >= {{ affected_interval_start }}
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

    -- The ingestion high-water mark folded into this day's numbers. A day
    -- rebuilt because of a correction carries the correction's ingestion time,
    -- so max() over the table is the newest arrival the model has absorbed.
    max(ingested_at)                                     as source_high_watermark

from observations
group by source_name, observation_date
