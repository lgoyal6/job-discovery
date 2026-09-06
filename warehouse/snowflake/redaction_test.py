"""Proof that probe.py cannot print an account host or a credential value.

Synthetic credentials only. This test never reads the real .env; it feeds
register_secrets a fabricated set and then asserts that a driver error message
shaped like the real one comes out clean. Run: python3 redaction_test.py
"""
import io
import sys
from contextlib import redirect_stdout

import probe

FAKE = {
    "SNOWFLAKE_ACCOUNT": "zz11111",
    "SNOWFLAKE_USER": "SYNTHETIC_USER",
    "SNOWFLAKE_PASSWORD": "synthetic-password-value",
    "SNOWFLAKE_ROLE": "SYNTHETIC_ROLE",
    "SNOWFLAKE_WAREHOUSE": "SYNTHETIC_WH",
    "SNOWFLAKE_DATABASE": "SYNTHETIC_DB",
    "SNOWFLAKE_SCHEMA": "SYNTHETIC_SCHEMA",
}

# Real Snowflake driver failures look like this.
SAMPLE = ("250001 (08001): Failed to connect to DB: "
          "zz11111.us-east-1.snowflakecomputing.com:443. "
          "Incorrect username or password was specified for user SYNTHETIC_USER "
          "with password synthetic-password-value on account zz11111 "
          "(also spelled zz_11111).")

FORBIDDEN = ["zz11111", "zz_11111", "SYNTHETIC_USER", "synthetic-password-value",
             "SYNTHETIC_ROLE", "SYNTHETIC_WH", "SYNTHETIC_DB", "SYNTHETIC_SCHEMA",
             "snowflakecomputing.com"]

failures = []

probe.register_secrets(FAKE)
out = probe.redact(SAMPLE)
for bad in FORBIDDEN:
    if bad in out:
        failures.append("redact() leaked %r" % bad)

buf = io.StringIO()
with redirect_stdout(buf):
    probe.say("error: %s", SAMPLE)
    probe.say("current_role: %s" % FAKE["SNOWFLAKE_ROLE"])
printed = buf.getvalue()
for bad in FORBIDDEN:
    if bad in printed:
        failures.append("say() leaked %r" % bad)

# The scrubber must not be a no-op that passes by deleting everything.
if "250001 (08001): Failed to connect to DB:" not in out:
    failures.append("redact() destroyed the diagnostic text")

print("scrubbed error line: %s" % out)
print("checked %d forbidden strings across redact() and say()" % len(FORBIDDEN))
if failures:
    for f in failures:
        print("FAIL: %s" % f)
    sys.exit(1)
print("REDACTION TEST: PASS")
