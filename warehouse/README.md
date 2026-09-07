# The warehouse

A dbt project over Postgres that demonstrates one specific failure and its fix:
**an incremental model that quietly loses a late-arriving correction.**

It is a self-contained demo, not part of the production pipeline. It has its own
Postgres container, its own port and its own synthetic dataset. Nothing here
reads the operational database, and nothing in `src/` imports any of it.

## The data is invented

Every company, requisition, URL and application-status event in `seeds/` is
fabricated by `seeds/generate_sample.py`, which is the sanitization boundary:
the warehouse is only ever loaded from its output. The generator is
deterministic on purpose, because the parity proof below compares two builds row
by row and would otherwise fail on generation noise rather than on logic.

## Running it

One command, from a clean clone. It needs Docker and a Python 3.11 or newer on
`PATH`, and nothing else:

```bash
bash warehouse/scripts/demonstrate.sh
```

That calls three prerequisites for you before it starts, each idempotent and
each fatal if it fails:

| script | what it does |
|---|---|
| `scripts/up.sh` | creates and waits for the `jobmarket-warehouse-dbt` Postgres container |
| `scripts/venv.sh` | builds `warehouse/.venv` from `requirements.txt` and puts dbt in it |
| `scripts/bootstrap.sh` | creates the landing schema and stages `seeds/*.csv` |

When you are done, `bash warehouse/scripts/down.sh` removes the container. There
is no volume, so that removes the data with it and the next run starts clean.

Everything is overridable through the environment: `WH_CONTAINER`, `WH_PORT`,
`WH_DB`, `WH_USER`, `WH_PASSWORD`, `WH_IMAGE`, `WH_PYTHON` and `DBT_BIN`. Set
`DBT_BIN` if you already have a dbt you would rather use, and `venv.sh` will
leave it alone.

## What the six stages prove

Each stage lands seven batches one at a time through the incremental path,
rebuilds every model from scratch on the same landing snapshot as a reference,
and then compares the two schemas with a symmetric `EXCEPT` over every model. A
row present on one side only, or differing in any column, fails the check.

| stage | what is in place | expected |
|---|---|---|
| 1 | naive staging cursor and naive day fact | parity FAILS, correction lost |
| 2 | staging fixed, day fact still appends new dates only | parity FAILS |
| 3 | the shipped models, both cursors on the ingestion clock | parity PASSES |
| 4 | negative control: interval start read off the wrong clock | parity FAILS |
| 5 | negative control: interval half open on the wrong side | parity FAILS |
| 6 | shipped models restored | parity PASSES |

Stages 4 and 5 exist because a check that has never failed has not been tested.
They are deliberately broken models that still *run*, so the failure is the
parity comparison and not a compile error.

## The rest of it

| | |
|---|---|
| `scripts/answers.sh` | the three analytical answers, each beside its denominator |
| `scripts/grains.sh` | each declared grain proved by a uniqueness check rather than a comment |
| `scripts/parity_check.sh` | the completion test on its own |
| `scripts/inspect_correction.sh <schema>` | the four figures the late correction moves |
| `scripts/replay.sh` · `scripts/full_rebuild.sh` | the incremental path · the reference build |
| `scripts/reset.sh` | empty the landing zone and drop both build schemas |
| `scripts/swap.sh <variant>` | put a demo variant of the two incremental models in place |
| `powerbi/` | the semantic model spec, and SQL equivalents of the DAX measures |
| `snowflake/` | a redaction test and a connectivity probe, both opt-in |

`tests/` holds twelve singular dbt tests, `models/` the staging, canonical and
mart layers, and `raw/001_landing.sql` the landing schema the sample is staged
into.
