-- INVARIANT: transitions within a requisition are strictly ordered in time.
-- Two transitions at the same instant make the "latest status" that the funnel
-- reads a coin flip.
select canonical_key, transition_seq, recorded_at, prev_recorded_at
from {{ ref('fct_application_status_transition') }}
where prev_recorded_at is not null
  and recorded_at <= prev_recorded_at
