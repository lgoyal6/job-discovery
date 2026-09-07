{% if target.name == 'dev' %}
with mismatch as (
  (select * from {{ ref('fct_source_observation_day') }}
   minus
   select * from {{ target.database }}.{{ env_var('SNOWFLAKE_FULL_SCHEMA', 'JM_WH_CODEX_FULL') }}.fct_source_observation_day)
  union all
  (select * from {{ target.database }}.{{ env_var('SNOWFLAKE_FULL_SCHEMA', 'JM_WH_CODEX_FULL') }}.fct_source_observation_day
   minus
   select * from {{ ref('fct_source_observation_day') }})
)
select * from mismatch
{% else %}
select 1 where false
{% endif %}
