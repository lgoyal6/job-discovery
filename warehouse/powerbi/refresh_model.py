"""Validate the checked-in semantic model and trigger a transactional refresh."""
from __future__ import annotations

import argparse
import json
import os
import time
import urllib.parse
import urllib.request
from pathlib import Path

MODEL = Path(__file__).with_name("JobMarket.SemanticModel") / "model.bim"
REQUIRED_MEASURES = {"Eligibility Yield Pct", "Late Arrival Pct", "Unknown Sponsorship"}


def validate_model(path: Path = MODEL) -> dict:
    payload = json.loads(path.read_text())
    tables = payload["model"]["tables"]
    names = {table["name"] for table in tables}
    if names != {"fct_source_observation_day", "dim_requisition_current"}:
        raise ValueError(f"unexpected semantic-model tables: {sorted(names)}")
    measures = {m["name"] for table in tables for m in table.get("measures", [])}
    missing = REQUIRED_MEASURES - measures
    if missing:
        raise ValueError(f"missing DAX measures: {sorted(missing)}")
    for table in tables:
        source = table["partitions"][0]["source"]
        expression = "\n".join(source["expression"])
        if source.get("type") != "m" or "Snowflake.Databases" not in expression:
            raise ValueError(
                f"{table['name']} is not backed by a Snowflake M partition"
            )
    return {"tables": len(tables), "measures": len(measures)}


def _request(opener, request):
    open_request = getattr(opener, "open", None) or opener.urlopen
    with open_request(request, timeout=30) as response:
        body = response.read()
        return response.status, dict(response.headers), json.loads(body) if body else {}


def refresh(*, opener=urllib.request, sleep=time.sleep) -> dict:
    required = ["AZURE_TENANT_ID", "POWERBI_CLIENT_ID", "POWERBI_CLIENT_SECRET",
                "POWERBI_WORKSPACE_ID", "POWERBI_DATASET_ID"]
    missing = [name for name in required if not os.environ.get(name)]
    if missing:
        raise RuntimeError(
            "missing Power BI environment variables: " + ", ".join(missing)
        )
    tenant = os.environ["AZURE_TENANT_ID"]
    token_body = urllib.parse.urlencode({
        "client_id": os.environ["POWERBI_CLIENT_ID"],
        "client_secret": os.environ["POWERBI_CLIENT_SECRET"],
        "scope": "https://analysis.windows.net/powerbi/api/.default",
        "grant_type": "client_credentials",
    }).encode()
    token_req = urllib.request.Request(
        f"https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token",
        data=token_body, method="POST",
    )
    _, _, token_payload = _request(opener, token_req)
    token = token_payload["access_token"]
    base = ("https://api.powerbi.com/v1.0/myorg/groups/" +
            os.environ["POWERBI_WORKSPACE_ID"] + "/datasets/" +
            os.environ["POWERBI_DATASET_ID"] + "/refreshes")
    refresh_req = urllib.request.Request(
        base,
        data=json.dumps({"type": "Full", "commitMode": "transactional",
                         "retryCount": 1}).encode(),
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    status, headers, _ = _request(opener, refresh_req)
    if status != 202:
        raise RuntimeError(f"Power BI refresh returned HTTP {status}")
    poll_url = headers.get("Location") or headers.get("location") or base
    for _ in range(120):
        poll_req = urllib.request.Request(
            poll_url, headers={"Authorization": f"Bearer {token}"}
        )
        _, _, state = _request(opener, poll_req)
        current = state.get("status")
        if current == "Completed":
            return state
        if current in {"Failed", "Cancelled", "Disabled"}:
            raise RuntimeError(f"Power BI refresh ended with {current}: {state}")
        sleep(5)
    raise TimeoutError("Power BI refresh did not finish within 10 minutes")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--validate-only", action="store_true")
    args = parser.parse_args()
    summary = validate_model()
    print(
        f"semantic model valid: {summary['tables']} tables, "
        f"{summary['measures']} DAX measures"
    )
    if not args.validate_only:
        result = refresh()
        print(f"Power BI refresh status={result['status']}")


if __name__ == "__main__":
    main()
