"""Authentication contract tests for the Snowflake operations verifier."""
from __future__ import annotations

import os
import sys
import types
import unittest
from unittest import mock

import verify_ops

BASE_ENV = {
    "SNOWFLAKE_ACCOUNT": "account",
    "SNOWFLAKE_USER": "user",
    "SNOWFLAKE_ROLE": "role",
    "SNOWFLAKE_DATABASE": "database",
    "SNOWFLAKE_WAREHOUSE": "warehouse",
}


class ConnectTest(unittest.TestCase):
    def fake_modules(self):
        captured = []
        connector = types.ModuleType("snowflake.connector")
        connector.connect = lambda **kwargs: captured.append(kwargs) or kwargs
        snowflake = types.ModuleType("snowflake")
        snowflake.connector = connector
        return {"snowflake": snowflake, "snowflake.connector": connector}, captured

    def test_password_auth_requires_and_forwards_password(self):
        modules, captured = self.fake_modules()
        with mock.patch.dict(os.environ, BASE_ENV, clear=True):
            with self.assertRaisesRegex(SystemExit, "SNOWFLAKE_PASSWORD"):
                verify_ops.connect()
        with mock.patch.dict(
            os.environ, {**BASE_ENV, "SNOWFLAKE_PASSWORD": "secret"}, clear=True
        ), mock.patch.dict(sys.modules, modules):
            verify_ops.connect()
        self.assertEqual(captured[-1]["authenticator"], "snowflake")
        self.assertEqual(captured[-1]["password"], "secret")

    def test_external_browser_does_not_require_password(self):
        modules, captured = self.fake_modules()
        environment = {**BASE_ENV, "SNOWFLAKE_AUTHENTICATOR": "externalbrowser"}
        with mock.patch.dict(os.environ, environment, clear=True), mock.patch.dict(
            sys.modules, modules
        ):
            verify_ops.connect()
        self.assertEqual(captured[-1]["authenticator"], "externalbrowser")
        self.assertNotIn("password", captured[-1])


if __name__ == "__main__":
    unittest.main()
