"""Verify warehouse auto-suspend and optionally remove bounded test schemas."""
from __future__ import annotations

import argparse
import os
import re

SAFE_SCHEMA = re.compile(r"^JM_WH_[A-Z0-9_]*(CODEX|TEST)[A-Z0-9_]*$")


def connect():
    authenticator = os.environ.get("SNOWFLAKE_AUTHENTICATOR", "snowflake")
    required = ["SNOWFLAKE_ACCOUNT", "SNOWFLAKE_USER", "SNOWFLAKE_ROLE",
                "SNOWFLAKE_DATABASE", "SNOWFLAKE_WAREHOUSE"]
    if authenticator.casefold() != "externalbrowser":
        required.append("SNOWFLAKE_PASSWORD")
    missing = [name for name in required if not os.environ.get(name)]
    if missing:
        raise SystemExit(
            "missing Snowflake environment variables: " + ", ".join(missing)
        )
    import snowflake.connector
    connection_args = dict(
        account=os.environ["SNOWFLAKE_ACCOUNT"],
        user=os.environ["SNOWFLAKE_USER"],
        authenticator=authenticator,
        role=os.environ["SNOWFLAKE_ROLE"],
        database=os.environ["SNOWFLAKE_DATABASE"],
        warehouse=os.environ["SNOWFLAKE_WAREHOUSE"],
        session_parameters={"QUERY_TAG": "jobmarket_ops_verification"},
    )
    password = os.environ.get("SNOWFLAKE_PASSWORD")
    if password:
        connection_args["password"] = password
    return snowflake.connector.connect(**connection_args)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--cleanup", action="store_true")
    args = parser.parse_args()
    schemas = [os.environ.get("SNOWFLAKE_SCHEMA", "JM_WH_CODEX"),
               os.environ.get("SNOWFLAKE_FULL_SCHEMA", "JM_WH_CODEX_FULL")]
    unsafe = any(not SAFE_SCHEMA.fullmatch(name.upper()) for name in schemas)
    if args.cleanup and unsafe:
        raise SystemExit(
            "refusing cleanup: schema names must contain CODEX or TEST and start JM_WH_"
        )
    with connect() as conn:
        cur = conn.cursor()
        cur.execute("SHOW WAREHOUSES LIKE %s", (os.environ["SNOWFLAKE_WAREHOUSE"],))
        row = cur.fetchone()
        if not row:
            raise SystemExit("configured warehouse not found")
        columns = [d[0].lower() for d in cur.description]
        record = dict(zip(columns, row))
        suspend = int(record.get("auto_suspend") or 0)
        if suspend <= 0 or suspend > 300:
            raise SystemExit(
                f"warehouse auto_suspend={suspend}; require 1..300 seconds"
            )
        print(f"warehouse auto_suspend={suspend}s")
        if args.cleanup:
            for schema in schemas:
                cur.execute(f'DROP SCHEMA IF EXISTS "{schema.upper()}"')
                print(f"dropped test schema {schema.upper()}")


if __name__ == "__main__":
    main()
