{{
  config(
    materialized       = 'incremental',
    unique_key         = 'canonical_key',
    incremental_strategy = 'delete+insert',
    on_schema_change   = 'fail'
  )
}}

-- depends_on: {{ ref('stg_source_observations') }}
--   The ref above is otherwise only reachable inside the is_incremental block,
--   and dbt builds its DAG by static analysis, so it has to be declared here or
--   this model can be scheduled before the staging table it reads.

-- GRAIN: one version per canonical requisition change. (canonical_key,
-- version_seq), valid over an interval on the OBSERVATION clock.
--
-- Only the most trusted source that has ever observed a requisition is allowed
-- to mint versions of it. That rule exists because of a real failure in the
-- operational pipeline: three sources wrote three spellings of one office into
-- one row, the fingerprint flipped between them on every pass, and each flip
-- was read as a new version. See migrations/007 and 008, which had to repair
-- 125 rows and one role that had been emailed 25 times. Aggregator spellings
-- are still counted as observations. They just do not get a vote on identity.
--
-- INCREMENTAL SHAPE: version_seq is a running count, so a version history
-- cannot be appended to safely; a correction landing in the middle of a key's
-- history renumbers everything after it. So the reprocessing unit is the whole
-- key. `unique_key = canonical_key` with delete+insert deletes every version
-- row for each affected key and reinserts its recomputed history. Affected
-- keys are found on the ingestion clock, which is what lets a day-2 correction
-- ingested on day 7 pull day 2 back into scope.

with authoritative as (

    select
        o.*,
        min(o.source_rank) over (partition by o.canonical_key) as best_rank
    from {{ ref('int_fetch_observations') }} o

    {% if is_incremental() %}
    where o.canonical_key in (
        select distinct s.canonical_key
        from {{ ref('stg_source_observations') }} s
        where s.ingested_at > {{ ingestion_watermark() }}
    )
    {% endif %}

),

trusted as (
    -- One source per key, not one rank per key: two ATS sources both rank 1,
    -- and letting both mint versions would reintroduce the flapping this rule
    -- exists to stop. Ties break on source_name so the choice is deterministic.
    select a.*
    from authoritative a
    join (
        select canonical_key, min(source_name) as chosen_source
        from authoritative
        where source_rank = best_rank
        group by canonical_key
    ) c
      on c.canonical_key = a.canonical_key
     and c.chosen_source = a.source_name
    where a.source_rank = a.best_rank
),

changes as (
    select
        t.*,
        lag(t.material_fingerprint) over (
            partition by t.canonical_key order by t.observed_at
        ) as prev_fingerprint
    from trusted t
),

version_starts as (
    select *
    from changes
    where prev_fingerprint is null
       or prev_fingerprint <> material_fingerprint
),

sequenced as (
    select
        canonical_key,
        row_number() over (partition by canonical_key order by observed_at) as version_seq,
        material_fingerprint,
        source_name          as minted_by_source,
        company,
        title,
        location,
        cycle,
        category,
        graduation_eligible,
        sponsorship_status,
        is_eligible,
        observed_at          as valid_from_observed_at,
        lead(observed_at) over (
            partition by canonical_key order by observed_at
        )                    as valid_to_observed_at,
        ingested_at          as first_ingested_at
    from version_starts
),

-- The ingestion high-water mark this key's history was built from. Stored on
-- the row so the next incremental run can read its own watermark back out
-- without a side table.
key_watermark as (
    select canonical_key, max(ingested_at) as built_from_ingested_at
    from authoritative
    group by canonical_key
)

select
    s.canonical_key,
    s.version_seq,
    s.canonical_key || '#' || s.version_seq as requisition_version_key,
    s.material_fingerprint,
    s.minted_by_source,
    s.company,
    s.title,
    s.location,
    s.cycle,
    s.category,
    s.graduation_eligible,
    s.sponsorship_status,
    s.is_eligible,
    s.valid_from_observed_at,
    s.valid_to_observed_at,
    (s.valid_to_observed_at is null) as is_current_version,
    s.first_ingested_at,
    w.built_from_ingested_at
from sequenced s
join key_watermark w using (canonical_key)
