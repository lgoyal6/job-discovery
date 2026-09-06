"""Read-only reachability and capacity probe for Snowflake.

WHAT THIS DOES NOT DO. It creates nothing. It runs no query against a table, so
it never resumes a warehouse and never bills compute. SHOW WAREHOUSES and
CURRENT_* are metadata calls served by the cloud services layer. It prints
warehouse names, sizes, auto-suspend settings and states, and it prints no
credential, no account identifier, no account host and no data.

REDACTION. Every line this script emits goes through say(), which scrubs each
loaded credential VALUE out of the text before it is printed, plus any
*.snowflakecomputing.com host by pattern. That is deliberately value-based
rather than pattern-based: a driver error message can carry the account
identifier in a shape no regex was written for, and the one thing known for
certain is the exact string that must never appear. Nothing in this file writes
to stdout except through say().

Its only job is to answer the question the plan puts before any Snowflake work:
is the account reachable, and does an appropriately small warehouse with
auto-suspend already exist? If either answer is no, the correct outcome is
BLOCKED with a named prerequisite, not a warehouse created by an agent.
"""

import os
import re
import sys

# Where the Snowflake credentials live, named at run time. A path baked into a
# checked-in file advertises where a credential file sits on somebody's disk,
# which is a thing worth not publishing even though the path is not itself a
# secret.
ENV_PATH = os.environ.get("SNOWFLAKE_ENV_FILE", "")
NEEDED = ["SNOWFLAKE_ACCOUNT", "SNOWFLAKE_USER", "SNOWFLAKE_PASSWORD",
          "SNOWFLAKE_ROLE", "SNOWFLAKE_WAREHOUSE", "SNOWFLAKE_DATABASE",
          "SNOWFLAKE_SCHEMA"]

# Populated by load_env. Every value here is scrubbed out of every printed line.
_SECRETS = []
_SECRET_PATTERNS = []

_HOST_RE = re.compile(r"[A-Za-z0-9_.-]+\.snowflakecomputing\.com", re.I)


def register_secrets(creds):
    """Remember every credential value so say() can strip it from output.

    Two passes per value, because one is not enough:

      1. The literal string, longest first, so that scrubbing a short value
         cannot chew a hole in the middle of a longer one.
      2. A separator-insensitive pattern built from the value with '-', '_' and
         '.' removed. Snowflake writes the same account identifier as
         org-account, org_account and orgaccount depending on which layer of
         the driver is talking, so a literal match alone leaks the spellings it
         was not shown. Gated at six characters of core so the pattern cannot
         be loose enough to match unrelated text.
    """
    literals, patterns = set(), []
    for v in creds.values():
        v = (v or "").strip()
        if len(v) < 4:
            continue
        literals.add(v)
        core = re.sub(r"[-_.]", "", v)
        if len(core) >= 6:
            patterns.append(re.compile(r"[-_.]?".join(re.escape(c) for c in core),
                                       re.I))
    _SECRETS[:] = sorted(literals, key=len, reverse=True)
    _SECRET_PATTERNS[:] = patterns


def redact(text):
    text = str(text)
    text = _HOST_RE.sub("<account-host>", text)
    for v in _SECRETS:
        if v in text:
            text = text.replace(v, "<redacted>")
    for pat in _SECRET_PATTERNS:
        text = pat.sub("<redacted>", text)
    return text


def say(fmt, *args):
    """The only way this script prints. Scrubs, then writes."""
    print(redact(fmt % args if args else fmt))


def load_env(path):
    creds = {}
    with open(path) as fh:
        for line in fh:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            creds[k.strip()] = v.strip().strip('"').strip("'")
    return creds


def main():
    if not ENV_PATH:
        say("BLOCKED: set SNOWFLAKE_ENV_FILE to the credential file to read")
        return 2
    if not os.path.exists(ENV_PATH):
        say("BLOCKED: no credential file at %s" % ENV_PATH)
        return 2
    creds = load_env(ENV_PATH)
    # Register BEFORE the first say() that could carry a value. Everything
    # after this line is scrubbed.
    register_secrets(creds)
    missing = [k for k in NEEDED if not creds.get(k)]
    say("credential file: present")
    say("required keys present: %d of %d" % (len(NEEDED) - len(missing), len(NEEDED)))
    if missing:
        say("missing keys: %s" % ", ".join(missing))
        say("BLOCKED: credentials incomplete")
        return 2

    try:
        import snowflake.connector
    except ImportError:
        say("BLOCKED: snowflake-connector-python not installed")
        return 2

    try:
        conn = snowflake.connector.connect(
            account=creds["SNOWFLAKE_ACCOUNT"],
            user=creds["SNOWFLAKE_USER"],
            password=creds["SNOWFLAKE_PASSWORD"],
            role=creds["SNOWFLAKE_ROLE"],
            # No warehouse on the session on purpose. Naming one here can resume
            # it on connect, and this probe must not start compute.
            login_timeout=30,
            network_timeout=30,
            client_session_keep_alive=False,
        )
    except Exception as exc:
        say("connection: FAILED")
        say("error class: %s" % type(exc).__name__)
        # First line only, and say() strips the account host and every
        # credential value out of it. The host is not a secret, but it names
        # the tenant and nothing in a portfolio record needs it.
        say("error: %s" % str(exc).splitlines()[0][:300])
        say("BLOCKED: account not reachable with these credentials")
        return 2

    say("connection: OK")
    cur = conn.cursor()
    try:
        cur.execute("select current_role(), current_region(), current_version()")
        role, region, version = cur.fetchone()
        say("current_role: %s" % role)
        say("current_region: %s" % region)
        say("snowflake_version: %s" % version)

        cur.execute("show warehouses")
        cols = [c[0].lower() for c in cur.description]
        rows = cur.fetchall()
        say("\nwarehouses visible to this role: %d" % len(rows))
        if rows:
            hdr = ("name", "size", "state", "auto_suspend", "auto_resume", "type")
            say("%-28s %-10s %-10s %-13s %-11s %s" % hdr)
            for r in rows:
                d = dict(zip(cols, r))
                print("%-28s %-10s %-10s %-13s %-11s %s" % (
                    d.get("name"), d.get("size"), d.get("state"),
                    d.get("auto_suspend"), d.get("auto_resume"), d.get("type")))
        else:
            say("BLOCKED: this role can see no warehouse")
            return 2
    finally:
        cur.close()
        conn.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
