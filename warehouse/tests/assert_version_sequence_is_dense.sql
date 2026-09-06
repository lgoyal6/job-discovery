-- INVARIANT: version_seq runs 1..n with no gaps and exactly one current
-- version per key. A gap is the signature of a partial incremental rebuild:
-- some versions replaced, others left behind from the previous run.
with per_key as (
    select
        canonical_key,
        count(*)                                   as versions,
        min(version_seq)                           as min_seq,
        max(version_seq)                           as max_seq,
        count(distinct version_seq)                as distinct_seq,
        count(*) filter (where is_current_version) as current_versions
    from {{ ref('dim_requisition_version') }}
    group by canonical_key
)
select *
from per_key
where min_seq <> 1
   or max_seq <> versions
   or distinct_seq <> versions
   or current_versions <> 1
