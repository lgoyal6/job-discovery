# Snowflake dbt execution path

This is an exact Snowflake path, separate from the existing PostgreSQL demo.
It uses `dbt-snowflake`, Snowflake `merge` incrementals, the ingestion clock,
and interval reprocessing for late corrections.

Install the opt-in dependencies, set the `SNOWFLAKE_*` variables named in
`profiles.yml`, then run:

```bash
python -m venv .venv
.venv/bin/pip install -r requirements.txt
PATH="$PWD/.venv/bin:$PATH" bash run_and_prove.sh
```

Password authentication is the default and requires `SNOWFLAKE_PASSWORD`.
For Snowflake browser SSO, set `SNOWFLAKE_AUTHENTICATOR=externalbrowser` and
leave `SNOWFLAKE_PASSWORD` unset. Both dbt and `verify_ops.py` use the selected
authenticator.

The proof runs through batch 6, incrementally lands the old-date correction in
batch 7, builds the same batch 7 snapshot from scratch in a second schema, and
requires symmetric `MINUS` parity. It then checks that the configured warehouse
auto-suspends within five minutes. Cleanup is deliberately separate:

```bash
.venv/bin/python verify_ops.py --cleanup
```

Cleanup refuses any schema that does not start with `JM_WH_` and contain
`CODEX` or `TEST`. It never drops the shared warehouse, database, or role.

## Live verification

A bounded run completed against Snowflake organization `YYWHZWU`, account
`QN49507`, and server 10.31.103. It used dbt Core 1.12.3 with the
dbt-snowflake 1.11.3 adapter and a dedicated `JOBMARKET_DBT` role. No token or
credential value is stored here.

The run loaded seed tables with 21 and 114 rows. The batch 6 build produced 111
staging rows and 33 fact rows. Batch 7 merged the three late corrections and
produced 28 fact rows. An independent full rebuild produced 114 staging rows
and 33 fact rows, and the symmetric `MINUS` parity test passed. The operational
check observed `JOBMARKET_WH` as an X-Small warehouse with 60-second
auto-suspend; it was initially suspended and `verify_ops.py` confirmed
`auto_suspend=60s` after the run.

The retained development schema finished with 114 staging rows, 33 fact rows,
and 15 dimension rows. The unused `JOBMARKET.JM_WH_CODEX_FULL` rebuild schema
was dropped and confirmed absent; the development schema remains available for
the Power BI import path.

`WAREHOUSE_METERING_HISTORY` reported 0.038229167 total credits, all compute,
and zero cloud-services credits for `JOBMARKET_WH`. Query-history attribution
reported:

| Query tag | Queries | Bytes scanned | Rows produced | Elapsed |
|---|---:|---:|---:|---:|
| `jobmarket_dbt_incremental` | 59 | 98,304 | 710 | 17,423 ms |
| `jobmarket_live_setup` | 10 | not recorded | not recorded | 1,964 ms |
| `jobmarket_live_verification` | 7 | 12,928 | 2 | 1,362 ms |
| `jobmarket_ops_verification` | 1 | not recorded | not recorded | 84 ms |

The metering query's own in-progress elapsed value was excluded from these
figures.
