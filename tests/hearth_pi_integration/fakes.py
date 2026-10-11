"""A fake Hearth Core listener (synthetic data only)."""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any

from aiohttp import web

TOKEN = "S" * 43
OTHER_TOKEN = "T" * 43


@dataclass
class FakeHearth:
    """A scripted Hearth: records requests and replies with NDJSON events."""

    token: str = TOKEN
    events: list[dict[str, Any]] = field(default_factory=list)
    cut_after: int | None = None
    requests: list[dict[str, Any]] = field(default_factory=list)
    headers: list[dict[str, str]] = field(default_factory=list)
    port: int = 0

    def authorized(self, request: web.Request) -> bool:
        return request.headers.get("Authorization") == f"Bearer {self.token}"

    async def info(self, request: web.Request) -> web.Response:
        self.headers.append(dict(request.headers))
        if "Origin" in request.headers or not self.authorized(request):
            return web.json_response({"error": "authentication_required"}, status=401)
        return web.json_response({"api": 1, "ready": True, "authenticated": True})

    async def conversation(self, request: web.Request) -> web.StreamResponse:
        self.headers.append(dict(request.headers))
        if "Origin" in request.headers or not self.authorized(request):
            return web.json_response({"error": "authentication_required"}, status=401)
        self.requests.append(await request.json())
        response = web.StreamResponse(headers={"Content-Type": "application/x-ndjson"})
        await response.prepare(request)
        for index, event in enumerate(self.events):
            if self.cut_after is not None and index >= self.cut_after:
                # Close mid-reply without an end event.
                return response
            await response.write(json.dumps(event).encode() + b"\n")
        await response.write_eof()
        return response
