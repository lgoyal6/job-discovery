-- INVARIANT: the warehouse cannot receive a row before a fetch saw it.
-- ingested_at < observed_at means the two clocks have been confused somewhere,
-- and every incremental cursor in this project depends on them being distinct.
select observation_id, source_name, observed_at, ingested_at
from {{ ref('stg_source_observations') }}
where ingested_at < observed_at
