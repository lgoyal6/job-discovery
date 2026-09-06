-- INVARIANT: identity is derived from observation, never invented. A version
-- row whose key no fetch ever produced would mean the canonical layer is
-- manufacturing requisitions.
select v.canonical_key
from {{ ref('dim_requisition_version') }} v
left join {{ ref('int_fetch_observations') }} o using (canonical_key)
where o.canonical_key is null
