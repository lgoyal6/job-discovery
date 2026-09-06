-- INVARIANT: a recorded transition's from_status is the previous transition's
-- to_status. A break means a status change happened that was never recorded,
-- so the tracker history has a hole in it and the funnel counts are reading
-- across that hole without saying so.
select
    canonical_key,
    transition_seq,
    from_status,
    prev_to_status,
    to_status
from {{ ref('fct_application_status_transition') }}
where (transition_seq = 1 and from_status is not null)
   or (transition_seq > 1 and from_status is distinct from prev_to_status)
