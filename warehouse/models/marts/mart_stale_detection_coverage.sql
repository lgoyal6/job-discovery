{{ config(materialized = 'table') }}

-- The denominator for Question 2, written down instead of implied. Every
-- requisition in the warehouse falls into exactly one bucket, and the buckets
-- sum to the population. A latency figure quoted without this table is a figure
-- quoted without its denominator.

with classified as (
    select
        canonical_key,
        case
            when first_observed_closed_at is not null
                 and last_observed_open_at is not null
                 and first_observed_closed_at > last_observed_open_at
                then 'measurable: observed open then observed closed'
            when first_observed_closed_at is not null
                 and last_observed_open_at is null
                then 'excluded: only ever observed closed, no open baseline'
            when first_observed_closed_at is not null
                then 'excluded: closed observation not after the last open one'
            when observation_count = 1
                then 'excluded: observed once, closure could not be detected'
            else 'censored: still open at the end of the window'
        end as coverage_bucket
    from {{ ref('dim_requisition_current') }}
)

select
    coverage_bucket,
    count(*) as requisitions,
    round(100.0 * count(*) / sum(count(*)) over (), 1) as pct_of_population
from classified
group by coverage_bucket
order by requisitions desc, coverage_bucket
