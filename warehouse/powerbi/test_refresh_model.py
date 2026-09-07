from __future__ import annotations

import json

import refresh_model


class Response:
    def __init__(self, status, payload=None, headers=None):
        self.status = status
        self.headers = headers or {}
        self._body = json.dumps(payload or {}).encode()
    def read(self): return self._body
    def __enter__(self): return self
    def __exit__(self, *_): return False


class Opener:
    def __init__(self): self.requests = []
    def open(self, request, timeout=30):
        self.requests.append(request)
        if len(self.requests) == 1:
            return Response(200, {"access_token": "secret-token"})
        if len(self.requests) == 2:
            return Response(202, headers={"Location": "https://api.powerbi.com/refresh/one"})
        return Response(200, {"status": "Completed"})


def test_model_is_machine_readable():
    assert refresh_model.validate_model()["measures"] >= 7


def test_refresh_uses_transactional_enhanced_refresh(monkeypatch):
    for name in ["AZURE_TENANT_ID", "POWERBI_CLIENT_ID", "POWERBI_CLIENT_SECRET",
                 "POWERBI_WORKSPACE_ID", "POWERBI_DATASET_ID"]:
        monkeypatch.setenv(name, "test-value")
    opener = Opener()
    result = refresh_model.refresh(opener=opener, sleep=lambda _: None)
    assert result["status"] == "Completed"
    body = json.loads(opener.requests[1].data)
    assert body["commitMode"] == "transactional"
    assert opener.requests[1].headers["Authorization"] == "Bearer secret-token"
