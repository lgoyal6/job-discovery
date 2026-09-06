-- INVARIANT: a requisition never returns to a fingerprint it already left.
--
-- This is the production bug from migrations/007 and 008 written as a test.
-- Three sources spelled one office three ways, each pass rewrote the row with
-- whichever spelling arrived last, and the fingerprint oscillated A -> B -> A
-- forever. Every oscillation was read as a genuine change; one role was emailed
-- 25 times. Restricting version minting to a single authoritative source per
-- requisition is what prevents it, and this test is what proves the restriction
-- is still in force.
select
    a.canonical_key,
    a.version_seq  as earlier_version,
    b.version_seq  as later_version,
    a.material_fingerprint
from {{ ref('dim_requisition_version') }} a
join {{ ref('dim_requisition_version') }} b
  on b.canonical_key = a.canonical_key
 and b.version_seq > a.version_seq + 1
 and b.material_fingerprint = a.material_fingerprint
