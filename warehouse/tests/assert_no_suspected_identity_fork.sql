{{ config(severity = 'warn') }}
-- INVARIANT, advisory: flag requisitions that look like one requisition wearing
-- two identities.
--
-- The canonical key is company + normalized title + cycle, taken straight from
-- the operational pipeline so this warehouse keys rows the same way the system
-- it models does. The consequence is unavoidable and worth stating plainly: an
-- employer who retitles a live requisition forks it into two canonical keys,
-- and the version dimension can never represent that as a version, because the
-- change moved the identity rather than the material.
--
-- This is not fixable inside the key definition; merging the two would need a
-- title-stability rule and a decision about which title is canonical, which is
-- a product question, not a modelling one. What is fixable is silence. A fork
-- has a signature: same company, same cycle, one title a prefix of the other,
-- and observation windows that do not overlap because the old title stopped
-- being observed exactly when the new one started. Warn on that signature so
-- the pair is visible to a human instead of being counted twice.
select
    a.canonical_key      as earlier_key,
    b.canonical_key      as later_key,
    a.title              as earlier_title,
    b.title              as later_title,
    a.last_observed_at   as earlier_last_observed_at,
    b.first_observed_at  as later_first_observed_at
from {{ ref('dim_requisition_current') }} a
join {{ ref('dim_requisition_current') }} b
  on b.company = a.company
 and b.cycle   = a.cycle
 and b.canonical_key <> a.canonical_key
 and position(lower(a.title) in lower(b.title)) = 1
where b.first_observed_at > a.last_observed_at
