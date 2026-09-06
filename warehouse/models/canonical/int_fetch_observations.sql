{{ config(materialized = 'view') }}

-- GRAIN: one source observation per fetch. (source_name, source_job_id,
-- observed_at) is the key; the highest revision of that fetch wins.
--
-- A view, on purpose. Collapsing revisions is a rank over a small table, and a
-- view cannot drift out of step with staging. Everything genuinely expensive
-- downstream is incremental; this is not the place to buy correctness risk for
-- a rewrite that costs nothing.

with ranked as (
    select
        obs.*,
        row_number() over (
            partition by source_name, source_job_id, observed_at
            order by revision desc
        ) as revision_rank,
        count(*) over (
            partition by source_name, source_job_id, observed_at
        ) as revision_count
    from {{ ref('stg_source_observations') }} obs
)

select
    md5(source_name || '|' || source_job_id || '|' || observed_at::text) as fetch_key,
    observation_id,
    batch_id,
    source_name,
    source_job_id,
    source_rank,
    revision,
    (revision_count > 1) as was_restated,
    posted_at,
    observed_at,
    ingested_at,
    observation_date,
    corrects_observation_id,
    correction_reason,
    is_late_arriving,
    company,
    title,
    location,
    cycle,
    category,
    posting_status,
    sponsorship_status,
    graduation_eligible,
    is_eligible,
    requirements,
    source_url,
    canonical_key,
    material_fingerprint
from ranked
where revision_rank = 1
