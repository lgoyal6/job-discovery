-- INVARIANT: the declared grain of the landing zone holds.
-- (source_name, source_job_id, observed_at, revision) identifies one row. If
-- this breaks, "one source observation per fetch" is not a grain, it is a hope.
select source_name, source_job_id, observed_at, revision, count(*) as n
from {{ ref('stg_source_observations') }}
group by 1, 2, 3, 4
having count(*) > 1
