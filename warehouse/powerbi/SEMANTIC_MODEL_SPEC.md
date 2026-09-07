# Power BI semantic model

`JobMarket.SemanticModel/model.bim` is a machine-readable, two-table Tabular
model with Snowflake Import partitions and seven DAX measures.
`refresh_model.py` validates its structure locally and can trigger a
transactional enhanced refresh for an already deployed Power BI dataset
through the official REST API.

**External status: LIVE, with bounded scope.** On 2026-09-07, Power BI Service
imported `JOBMARKET.JM_WH_CODEX.DIM_REQUISITION_CURRENT` and
`JOBMARKET.JM_WH_CODEX.FCT_SOURCE_OBSERVATION_DAY` from Snowflake into the
semantic model `Job Market Snowflake Analytics`. The model accepted all seven
measures through TMDL view, completed an explicit service refresh, and executed
the declared DAX through DAX query view.

The deployed service model is the bounded two-table model represented by
`model.bim`. The six-table model and three date relationships described later
in this document remain a design for a broader analytical surface. They were
not silently treated as deployed.

## Live Power BI Service verification

- Workspace ID: `2220fdb8-7dd4-4a83-b554-cf0bee7d3808`
- Semantic model ID: `ff41aace-8ea6-4e4b-bed8-108aa5890ff7`
- Report: `Job Market Snowflake Analytics Report`
- Report ID: `930ca212-36a5-44f4-890d-314db8eaafb0`
- Import preview: 15 dimension rows and 33 fact rows
- TMDL apply: succeeded with zero problems
- Explicit semantic-model refresh: workspace timestamp advanced from
  `9/7/2026, 12:23:03 AM` to `9/7/2026, 12:37:10 AM`
- Post-refresh DAX query: succeeded in 957.5 ms with one seven-column row

```text
Observed Requisitions           113
Eligible Requisitions           103
Eligibility Yield Pct           91.2%
Late Arrival Pct                2.6%
Closed Observation Pct          9.6%
Eligible Requisition Universe   13
Unknown Sponsorship             4
```

The saved report was reopened in reading view and rendered four cards plus a
source-by-observation-date table. The table totals matched the DAX query: 113
observed and 103 eligible requisitions.

The live refresh used Power BI Service's `Refresh now` action, not
`refresh_model.py`. The service-principal REST helper remains locally contract
tested only. This substitution is stated because the repository helper and the
service UI are different mechanisms even though both refresh the same model.

---

## 1. Storage mode and source

Import mode against the Snowflake `JOBMARKET.JM_WH_CODEX` schema. Not
DirectQuery: the warehouse is rebuilt by a dbt run, so the data is only as fresh
as the last run anyway, and DirectQuery would put a Snowflake query behind every
visual interaction for no gain in freshness.

## 2. Broader six-table design

The live model imports the first and third rows below. The other four rows and
the relationships in section 3 are still proposed scope.

| Table | Role | Grain | Source |
|---|---|---|---|
| `dim_requisition_current` | dimension | one row per canonical requisition | `jm_wh.dim_requisition_current` |
| `dim_requisition_version` | fact (versions) | one row per version of a requisition | `jm_wh.dim_requisition_version` |
| `fct_source_observation_day` | fact (daily) | one row per source per observation date | `jm_wh.fct_source_observation_day` |
| `fct_application_status_transition` | fact (events) | one row per recorded status transition | `jm_wh.fct_application_status_transition` |
| `dim_source` | dimension | one row per source | derived, see below |
| `dim_date` | date table | one row per day | generated, see below |

`dim_source` is a small calculated table rather than a column on the fact,
because source trust order (`source_rank`) is a property of the source and
belongs in one place:

```dax
dim_source =
DATATABLE(
    "source_name", STRING, "source_rank", INTEGER, "source_class", STRING,
    {
        {"greenhouse", 1, "ATS"}, {"lever", 1, "ATS"},
        {"ashby", 1, "ATS"},      {"smartrecruiters", 1, "ATS"},
        {"linkedin", 5, "Aggregator"},
        {"intern-list", 6, "Curated list"},
        {"community", 7, "Community list"}
    }
)
```

## 3. THE DATE PROBLEM, and why there are three date relationships

This is the part a default Power BI model gets wrong, and it is the same
mistake as the incremental cursor bug: collapsing three clocks into one.

The warehouse keeps them separate on purpose:

- `posted_at` - what the employer claims about when the requisition went live
- `observed_at` - when a fetch saw the content
- `ingested_at` - when the row reached the warehouse

A single active relationship on "the date" would silently pick one and answer
every question with it. So:

- **Active** relationship: `dim_date[date]` → `fct_source_observation_day[observation_date]`,
  single direction, one-to-many. The observation clock is the default because
  every question about *what the market looked like* is a question about when
  something was seen.
- **Inactive** relationship: `dim_date[date]` → `fct_source_observation_day[ingestion_date]`
  (a calculated column, `source_high_watermark` cast to date). Activated with
  `USERELATIONSHIP` only inside the freshness and late-arrival measures, which
  are the only questions about *our* clock rather than the market's.
- **Inactive** relationship: `dim_date[date]` → `dim_requisition_current[posted_date]`
  (calculated from `earliest_claimed_posted_at`). Activated only in measures
  about employer-claimed posting age, and every such measure carries the word
  "claimed" in its name because the value is an assertion by a third party, not
  an observation.

`dim_date` is marked as the date table, and its range is generated from the
data rather than hardcoded:

```dax
dim_date =
VAR MinDate = MIN( fct_source_observation_day[observation_date] )
VAR MaxDate = MAX( fct_source_observation_day[observation_date] )
RETURN
ADDCOLUMNS(
    CALENDAR( MinDate, MaxDate ),
    "Year",        YEAR( [Date] ),
    "Month",       FORMAT( [Date], "yyyy-MM" ),
    "ISO Week",    WEEKNUM( [Date], 21 ),
    "Day of Week", FORMAT( [Date], "ddd" )
)
```

**A gap is not a zero.** `CALENDAR` produces a contiguous range, so a day on
which no source ran appears as a row with no facts. Every rate measure below
returns `BLANK()` on such a day rather than 0, because "no fetch ran" and "a
fetch ran and found nothing" are different facts and a line chart that draws
them the same way is lying. That is what the `HASONEVALUE`/`ISBLANK` guards in
the measures are for.

## 4. Measures

Every rate is written as an explicit numerator over an explicit denominator.
None of them uses an implicit measure or a drag-and-drop aggregation.

### 4.1 Q1 - source yield

```dax
Eligible Requisition Universe =
CALCULATE(
    DISTINCTCOUNT( dim_requisition_current[canonical_key] ),
    dim_requisition_current[is_eligible] = TRUE()
)

Eligible Observed by Source =
CALCULATE(
    DISTINCTCOUNT( dim_requisition_current[canonical_key] ),
    dim_requisition_current[is_eligible] = TRUE(),
    CROSSFILTER( fct_source_observation_day[source_name], dim_source[source_name], BOTH )
)

Sole Source Eligible =
-- Requisitions this source saw that NO other source ever saw.
CALCULATE(
    [Eligible Observed by Source],
    FILTER( dim_requisition_current, dim_requisition_current[source_count] = 1 )
)

Pct of Eligible Universe Observed =
VAR Denominator = CALCULATE( [Eligible Requisition Universe], REMOVEFILTERS( dim_source ) )
VAR Numerator   = [Eligible Observed by Source]
RETURN
IF( Denominator = 0, BLANK(), DIVIDE( Numerator, Denominator ) )
```

`REMOVEFILTERS( dim_source )` on the denominator is the whole point. Without it
the source slicer shrinks the denominator along with the numerator and every
source scores 100 percent of itself. The denominator is the eligible universe,
not the eligible universe this source happened to see.

### 4.2 Q2 - stale detection latency

```dax
Measurable Closures =
CALCULATE(
    DISTINCTCOUNT( dim_requisition_current[canonical_key] ),
    NOT ISBLANK( dim_requisition_current[first_observed_closed_at] ),
    NOT ISBLANK( dim_requisition_current[last_observed_open_at] ),
    dim_requisition_current[first_observed_closed_at] > dim_requisition_current[last_observed_open_at]
)

Censored Requisitions =            -- still open at the end of the window
CALCULATE(
    DISTINCTCOUNT( dim_requisition_current[canonical_key] ),
    ISBLANK( dim_requisition_current[first_observed_closed_at] )
)

Median Detection Latency (hrs) =
VAR Denominator = [Measurable Closures]
RETURN
IF(
    Denominator = 0,
    BLANK(),                       -- no measurable closure, not "0 hours"
    MEDIANX(
        FILTER(
            dim_requisition_current,
            NOT ISBLANK( dim_requisition_current[first_observed_closed_at] ) &&
            NOT ISBLANK( dim_requisition_current[last_observed_open_at] ) &&
            dim_requisition_current[first_observed_closed_at] > dim_requisition_current[last_observed_open_at]
        ),
        DATEDIFF(
            dim_requisition_current[last_observed_open_at],
            dim_requisition_current[first_observed_closed_at],
            HOUR
        )
    )
)

Latency Coverage Pct =
DIVIDE( [Measurable Closures], [Measurable Closures] + [Censored Requisitions] )
```

`Latency Coverage Pct` is required furniture, not a nice-to-have. The latency
number is computed on the minority of requisitions that closed inside the
window, and any visual showing the latency must show the coverage beside it or
it presents a number measured on 20 percent of the population as if it
described all of it.

### 4.3 Q3 - requirement recurrence

```dax
Requisitions With Requirements Text =
CALCULATE(
    DISTINCTCOUNT( dim_requisition_current[canonical_key] ),
    FILTER( dim_requisition_current, dim_requisition_current[observation_count] > 0 ),
    fct_source_observation_day[observations_with_requirements] > 0
)

Requirement Recurrence Pct =
VAR Denominator = [Requisitions With Requirements Text]
RETURN
IF( Denominator = 0, BLANK(), DIVIDE( [Requisitions Naming Requirement], Denominator ) )

Requirement Text Coverage Pct =
DIVIDE(
    [Requisitions With Requirements Text],
    CALCULATE( DISTINCTCOUNT( dim_requisition_current[canonical_key] ) )
)
```

The denominator is requisitions whose text we actually have, never the whole
family. Two of the six sources are link lists that carry no posting body, so
dividing by the family would convert "we never had the text" into "the
requirement is absent", which is a different and false claim.

### 4.4 Tracker measures, named for what they are

```dax
Flagged Applied = CALCULATE( DISTINCTCOUNT( fct_application_status_transition[canonical_key] ),
                             fct_application_status_transition[is_applied_flag] = TRUE() )

Flagged Rejected = CALCULATE( DISTINCTCOUNT( fct_application_status_transition[canonical_key] ),
                              fct_application_status_transition[is_rejected_flag] = TRUE() )

Pct Flagged Applied =
IF( [Eligible Requisition Universe] = 0, BLANK(),
    DIVIDE( [Flagged Applied], [Eligible Requisition Universe] ) )
```

The measure is `Flagged Applied`, not `Applications Submitted`, and the
distinction is load-bearing rather than pedantic. The underlying fact is a
checkbox in a personal tracker. There is no confirmation number behind it, no
employer-side acknowledgement, and a submission that failed after the checkbox
was ticked is indistinguishable from one that succeeded. `Flagged Rejected`
carries a second caveat on top: the tracker records that a status was set and
no reason at all, so no measure in this model can be used to explain **why**
anything was rejected. Any such explanation would be constructed by the reader,
not observed by the pipeline. The report is specified to display these two
measures under a header reading "tracker flags, self-reported" for that reason.

## 5. Unknown-category behaviour

The rule, applied everywhere: **`UNKNOWN` is a value, `BLANK` is an absence,
and neither is silently folded into a bucket that reads as a decision.**

- `sponsorship_status` has three values: `SUPPORTED`, `UNKNOWN`, `UNSUPPORTED`.
  `UNKNOWN` is its own legend entry with its own neutral colour, never merged
  into `UNSUPPORTED`. A posting that says nothing about sponsorship has not
  refused to sponsor, and the eligibility rule reflects that: eligible means
  the graduation window admits the applicant **and** sponsorship is not
  `UNSUPPORTED`, so `UNKNOWN` stays eligible.
- Any column arriving NULL is given an explicit `"Unknown"` member in Power
  Query rather than being left blank, so it appears in slicers and cannot be
  dropped from a chart by an inner join.
- `role_family` NULL becomes `"Unclassified"`, and the classifier's coverage is
  shown next to any chart broken down by family.
- No measure returns 0 for an empty selection. Every rate measure guards its
  denominator and returns `BLANK()`, so an empty visual reads as empty rather
  than as a measured zero.

## 6. Report pages specified

1. **Source yield** - bar of `Pct of Eligible Universe Observed` by source, with
   `Sole Source Eligible` as a second series and `Eligible Requisition
   Universe` pinned as a card so the denominator is on screen.
2. **Freshness and staleness** - `Median Detection Latency (hrs)` with
   `Latency Coverage Pct` beside it, and a bar of the coverage buckets so the
   censored share is visible rather than implied.
3. **Requirements by family** - matrix of requirement by role family showing
   `Requirement Recurrence Pct` and `Requirement Text Coverage Pct` in adjacent
   columns, so a 100 percent over one requisition cannot be read as a 100
   percent over nine.
4. **Ingestion health** - late-arriving and restated counts by day on the
   ingestion relationship, which is the page that would have shown the
   correction bug this project demonstrates.
