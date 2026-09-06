-- INVARIANT, and the one that catches an incomplete interval reprocess: the
-- incremental day fact must agree with a direct count over the observations it
-- summarises, for every day. This is the test that fails when a correction
-- lands on an old day and the model only ever appends new ones.
with recomputed as (
    select
        source_name,
        observation_date,
        count(*)                    as observation_count,
        count(distinct canonical_key) as requisition_count
    from {{ ref('int_fetch_observations') }}
    group by 1, 2
)
select
    coalesce(f.source_name, r.source_name)           as source_name,
    coalesce(f.observation_date, r.observation_date) as observation_date,
    f.observation_count                              as fact_observations,
    r.observation_count                              as recomputed_observations,
    f.requisition_count                              as fact_requisitions,
    r.requisition_count                              as recomputed_requisitions
from {{ ref('fct_source_observation_day') }} f
full outer join recomputed r
  on r.source_name = f.source_name
 and r.observation_date = f.observation_date
where f.source_name is null
   or r.source_name is null
   or f.observation_count is distinct from r.observation_count
   or f.requisition_count is distinct from r.requisition_count
