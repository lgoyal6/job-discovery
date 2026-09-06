{{ config(materialized = 'table') }}

-- QUESTION 3: which requirements recur by role family?
--
-- DENOMINATOR, and it is not the obvious one:
--   family_requisitions_with_requirements = distinct requisitions in that role
--   family for which at least one observation carried a parseable requirements
--   list. Requisitions in the family that were never observed with prose are
--   NOT in the denominator, because "this requirement appears in 0 of them" and
--   "we never had the text" are different statements and dividing by the whole
--   family silently converts the second into the first.
--
-- Coverage is carried on every row so the denominator travels with the number.
-- A recurrence of 100 percent over 2 of 9 requisitions is not the same finding
-- as 100 percent over 9 of 9, and a table that reports only the percentage
-- cannot tell you which one you are looking at.
--
-- WHY THE TEXT IS MISSING. Two of the six sources are link lists: they name a
-- role and link out without carrying the posting body. That is the same gap the
-- operational pipeline hit, where 92 percent of digest roles read "Required
-- skills: Not stated" (migrations/005). It is a property of the source mix, not
-- of the employers.

with observed_requirements as (
    select distinct
        o.canonical_key,
        c.role_family,
        trim(lower(unnest(string_to_array(o.requirements, '|')))) as requirement
    from {{ ref('int_fetch_observations') }} o
    join {{ ref('dim_requisition_current') }} c using (canonical_key)
    where o.requirements <> ''
),

family_coverage as (
    select
        c.role_family,
        count(*) as family_requisitions_total,
        count(*) filter (where r.canonical_key is not null) as family_requisitions_with_requirements
    from {{ ref('dim_requisition_current') }} c
    left join (select distinct canonical_key from observed_requirements) r
      using (canonical_key)
    group by c.role_family
)

select
    o.role_family,
    o.requirement,
    count(distinct o.canonical_key)                     as requisitions_naming_it,
    f.family_requisitions_with_requirements,
    f.family_requisitions_total,
    round(100.0 * count(distinct o.canonical_key)
          / nullif(f.family_requisitions_with_requirements, 0), 1)
                                                        as pct_of_covered_requisitions,
    round(100.0 * f.family_requisitions_with_requirements
          / nullif(f.family_requisitions_total, 0), 1)   as family_text_coverage_pct
from observed_requirements o
join family_coverage f using (role_family)
where o.requirement <> ''
group by o.role_family, o.requirement,
         f.family_requisitions_with_requirements, f.family_requisitions_total
order by o.role_family, requisitions_naming_it desc, o.requirement
