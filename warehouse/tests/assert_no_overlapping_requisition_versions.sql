-- INVARIANT: a requisition has exactly one version in force at any instant.
-- Overlapping validity intervals make "what did this say on Tuesday"
-- ambiguous, which is the question the version grain exists to answer.
select
    v.canonical_key,
    v.version_seq,
    v.valid_from_observed_at,
    v.valid_to_observed_at,
    n.version_seq as next_version_seq
from {{ ref('dim_requisition_version') }} v
join {{ ref('dim_requisition_version') }} n
  on n.canonical_key = v.canonical_key
 and n.version_seq = v.version_seq + 1
where v.valid_to_observed_at is null
   or v.valid_to_observed_at <> n.valid_from_observed_at
