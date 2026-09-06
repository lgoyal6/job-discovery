{{
  config(
    materialized       = 'incremental',
    unique_key         = 'event_id',
    incremental_strategy = 'delete+insert',
    on_schema_change   = 'fail'
  )
}}

-- GRAIN: one recorded application-status transition. Same cursor rule as
-- observations: recorded_at is the tracker's clock and can be backdated when a
-- status is filled in after the fact, so ingested_at is what the cursor reads.
--
-- The vocabulary is deliberately hedged. The tracker has a checkbox; a checkbox
-- is a thing a human ticked, not a receipt from an employer's application
-- system. APPLIED_FLAGGED and REJECTED_FLAGGED say what is actually known.

with landed as (

    select * from {{ source('raw', 'application_status_events') }}

    {% if is_incremental() %}
    where ingested_at > (
      select coalesce(max(ingested_at), '-infinity'::timestamptz) from {{ this }}
    )
    {% endif %}

)

select
    event_id,
    batch_id,
    canonical_key,
    nullif(from_status, '')  as from_status,
    to_status,
    recorded_at,             -- when the tracker recorded it
    ingested_at,             -- when we received it
    evidence
from landed
