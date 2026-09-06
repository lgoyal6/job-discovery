{{ config(materialized = 'table') }}

-- The application tracker, reported for what it is.
--
-- DENOMINATOR: eligible requisitions in the window. A requisition that was
-- never eligible was never a candidate for an application, so including it
-- would understate every rate below.
--
-- READ THE COLUMN NAMES LITERALLY. flagged_applied counts requisitions whose
-- most recent recorded transition reached APPLIED_FLAGGED. That is a checkbox
-- in a personal tracker. It is not proof that an application was submitted:
-- there is no confirmation number behind it, no employer-side acknowledgement,
-- and a submission that failed after the tracker was updated is
-- indistinguishable from one that succeeded. flagged_rejected is the same
-- caveat with a second one on top: the tracker records that a status was set
-- to Rejected and carries no reason at all, so nothing in this warehouse is
-- evidence of WHY anything was rejected. Any such explanation would be
-- constructed here, not observed.

with latest_transition as (
    select distinct on (canonical_key)
        canonical_key,
        to_status  as latest_status,
        recorded_at as latest_recorded_at,
        transition_seq as transition_count
    from {{ ref('fct_application_status_transition') }}
    order by canonical_key, transition_seq desc
),

eligible as (
    select canonical_key, role_family
    from {{ ref('dim_requisition_current') }}
    where is_eligible
)

select
    e.role_family,
    count(*)                                                          as eligible_requisitions,
    count(t.canonical_key)                                            as reached_the_tracker,
    count(*) filter (where t.latest_status = 'MIRRORED')              as stopped_at_mirrored,
    count(*) filter (where t.latest_status = 'APPLIED_FLAGGED')       as flagged_applied,
    count(*) filter (where t.latest_status = 'REJECTED_FLAGGED')      as flagged_rejected,
    round(100.0 * count(t.canonical_key) / nullif(count(*), 0), 1)    as pct_reached_tracker,
    round(100.0 * count(*) filter (where t.latest_status in ('APPLIED_FLAGGED','REJECTED_FLAGGED'))
          / nullif(count(*), 0), 1)                                   as pct_flagged_applied_or_later
from eligible e
left join latest_transition t using (canonical_key)
group by e.role_family
order by eligible_requisitions desc, e.role_family
