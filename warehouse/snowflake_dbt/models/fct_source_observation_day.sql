{{
  config(
    materialized='incremental',
    unique_key='source_day_key',
    incremental_strategy='merge'
  )
}}

{% if is_incremental() %}
{% set affected_start %}
  (select coalesce(min(observation_date), current_date())
   from {{ ref('stg_source_observations') }}
   where ingested_at > (
     select coalesce(max(source_high_watermark), '1900-01-01'::timestamp_tz) from {{ this }}
   ))
{% endset %}
{% endif %}

with observations as (
  select * from {{ ref('stg_source_observations') }}
  {% if is_incremental() %}
    where observation_date >= {{ affected_start }}
  {% endif %}
)
select
  source_name || '|' || to_varchar(observation_date) as source_day_key,
  source_name,
  observation_date,
  count(*) as observation_count,
  count(distinct canonical_key) as requisition_count,
  count_if(graduation_eligible and sponsorship_status <> 'UNSUPPORTED') as eligible_requisition_count,
  count_if(posting_status = 'OPEN') as open_observation_count,
  count_if(posting_status = 'CLOSED') as closed_observation_count,
  count_if(requirements <> '') as observations_with_requirements,
  count_if(is_late_arriving) as late_arriving_observation_count,
  max(ingested_at) as source_high_watermark
from observations
group by source_name, observation_date
