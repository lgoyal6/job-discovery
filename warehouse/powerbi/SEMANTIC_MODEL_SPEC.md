# Power BI semantic model - SPECIFICATION ONLY, NOT EXECUTED

**Status: BLOCKED. Nothing in this file has been run, opened, refreshed or
validated in Power BI.** It is a written design, and it should be read as a
design document rather than as a report of something that works.

## Why it is blocked, measured

```
$ ls /Applications | grep -iE "power ?bi|tabular|dax"
no Power BI / Tabular Editor / DAX Studio app
$ command -v pbi-tools pbicmd TabularEditor tabular-editor dax
not found: pbi-tools
not found: pbicmd
not found: TabularEditor
not found: tabular-editor
not found: dax
$ brew list --cask | grep -iE "power|tabular|dax"
no matching cask installed
$ brew search --cask powerbi
powder                      # unrelated formula, no Power BI cask exists
$ dotnet --version
no dotnet
```

Power BI Desktop is a Windows-only application. Microsoft ships no macOS build,
and the authoring surface that produces a `.pbix` is that application. The
alternatives are equally unavailable here: Tabular Editor and DAX Studio are
.NET desktop applications with no macOS build and no dotnet runtime installed,
and the XMLA endpoint route needs a Power BI Premium or Fabric capacity plus an
Entra ID tenant, none of which exists for this project.

**PREREQUISITE, exactly.** One of:

1. A Windows machine (or a Windows VM, or Parallels on this Mac) running Power
   BI Desktop, plus the Npgsql provider so it can read PostgreSQL; **or**
2. A Power BI / Fabric workspace on Premium or Fabric capacity with the XMLA
   read-write endpoint enabled, an Entra ID service principal with workspace
   contributor rights, and a network path from that capacity to the warehouse
   (a gateway, since the warehouse here is a container on localhost).

Neither exists. Until one does, the correct output is this specification and an
honest BLOCKED label, not a screenshot of a dashboard that was never built.

## What "would work" is and is not claimed

The SQL side of every measure below **is** exercised: each measure has a SQL
equivalent in `powerbi/measure_equivalents.sql`, run against the built
warehouse, and the numbers it returns are recorded there. That proves the
*arithmetic and the denominators* are right. It does not prove the DAX is
syntactically valid, that the relationships behave as described, or that the
report renders. Nobody has compiled this DAX.

---

## 1. Storage mode and source

Import mode against the `jm_wh` schema. Not DirectQuery: the warehouse is
rebuilt by a scheduled dbt run, so the data is only as fresh as the last run
anyway, and DirectQuery would put a Postgres query behind every visual
interaction for no gain in freshness.

## 2. Tables

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
