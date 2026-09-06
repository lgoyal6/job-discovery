{{
  config(
    materialized       = 'incremental',
    unique_key         = 'canonical_key',
    incremental_strategy = 'delete+insert',
    on_schema_change   = 'fail'
  )
}}

-- GRAIN: one recorded application-status transition, sequenced within its
-- requisition. Append-only in the source, so a status is never overwritten:
-- "currently rejected" is derived from the last transition, not stored as a
-- column that erased what came before it.
--
-- Same key-scoped reprocessing as the version dimension, for the same reason:
-- transition_seq is a running count within a key, so a backdated status filled
-- in after the fact renumbers the rest of that key's chain.
--
-- WHAT THESE ROWS DO NOT MEAN. APPLIED_FLAGGED records that a checkbox was
-- ticked in a personal tracker. It is not a receipt from an employer's system,
-- there is no confirmation number behind it, and a submission that failed
-- silently looks exactly the same. REJECTED_FLAGGED records that the tracker
-- was set to Rejected; it carries no reason, and inferring one from the
-- requisition's attributes would be inventing the reason, not reading it.

with scoped as (

    select * from {{ ref('stg_application_status_events') }}

    {% if is_incremental() %}
    where canonical_key in (
        select distinct canonical_key
        from {{ ref('stg_application_status_events') }}
        where ingested_at > {{ ingestion_watermark() }}
    )
    {% endif %}

),

sequenced as (
    select
        s.*,
        row_number() over (partition by canonical_key order by recorded_at, event_id) as transition_seq,
        lag(to_status)   over (partition by canonical_key order by recorded_at, event_id) as prev_to_status,
        lag(recorded_at) over (partition by canonical_key order by recorded_at, event_id) as prev_recorded_at,
        max(ingested_at) over (partition by canonical_key) as built_from_ingested_at
    from scoped s
)

select
    canonical_key,
    transition_seq,
    event_id,
    from_status,
    to_status,
    prev_to_status,
    recorded_at,
    prev_recorded_at,
    extract(epoch from (recorded_at - prev_recorded_at)) / 3600.0 as hours_in_previous_status,
    ingested_at,
    built_from_ingested_at,
    evidence,
    -- Stated as a flag, never as a fact about the employer.
    (to_status = 'APPLIED_FLAGGED')   as is_applied_flag,
    (to_status = 'REJECTED_FLAGGED')  as is_rejected_flag
from sequenced
