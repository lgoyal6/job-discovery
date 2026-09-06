-- INVARIANT: is_eligible is the macro's definition and nothing else. Every Q1
-- denominator divides by this column, so a hand-rolled second definition
-- leaking into any model would silently change what the percentages mean.
select canonical_key, graduation_eligible, sponsorship_status, is_eligible
from {{ ref('dim_requisition_current') }}
where is_eligible is distinct from
      (graduation_eligible and sponsorship_status <> 'UNSUPPORTED')
