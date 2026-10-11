"""A small client for Hearth's Core listener (Hearth Assist, API 1).

Hearth publishes {host, port, api, token} through Supervisor discovery. Every
request carries ``Authorization: Bearer <token>`` and never an Origin header.
The conversation endpoint answers with newline-delimited JSON events:
``start``, any number of ``delta`` events and one ``end`` event.
"""

from __future__ import annotations

import json
from collections.abc import AsyncIterator
from typing import Any

import aiohttp

from .const import API_VERSION

# Hearth waits about 25 seconds for a turn, then says it is still working.
REQUEST_TIMEOUT = aiohttp.ClientTimeout(total=60, connect=10, sock_read=45)
INFO_TIMEOUT = aiohttp.ClientTimeout(total=10)
MAX_LINE = 65536


class HearthError(Exception):
    """Hearth could not be used."""


class HearthConnectionError(HearthError):
    """Hearth was unreachable or the reply was cut off."""


class HearthAuthError(HearthError):
    """Hearth refused the link secret."""


class HearthProtocolError(HearthError):
    """Hearth answered with something this integration does not understand."""


class HearthClient:
    """Talk to one Hearth add-on."""

    def __init__(
        self,
        session: aiohttp.ClientSession,
        host: str,
        port: int,
        token: str,
    ) -> None:
        """Initialize the client."""
        self._session = session
        self._base = f"http://{host}:{port}/core/v1"
        self._token = token

    def __repr__(self) -> str:
        """Never show the link secret."""
        return f"HearthClient({self._base!r})"

    @property
    def _headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self._token}"}

    async def async_info(self) -> dict[str, Any]:
        """Return Hearth's API version and readiness; checks the secret."""
        try:
            async with self._session.get(
                f"{self._base}/info",
                headers=self._headers,
                timeout=INFO_TIMEOUT,
                allow_redirects=False,
            ) as response:
                if response.status in (401, 403):
                    raise HearthAuthError
                if response.status != 200:
                    raise HearthConnectionError(f"status {response.status}")
                info = await response.json(content_type=None)
        except HearthError:
            raise
        except (aiohttp.ClientError, TimeoutError, ValueError) as err:
            raise HearthConnectionError(type(err).__name__) from None
        if not isinstance(info, dict) or info.get("api") != API_VERSION:
            raise HearthProtocolError("unsupported api")
        return info

    async def async_converse(
        self, payload: dict[str, Any]
    ) -> AsyncIterator[dict[str, Any]]:
        """Send one voice turn; yield Hearth's events as they arrive."""
        try:
            async with self._session.post(
                f"{self._base}/conversation",
                json={"api": API_VERSION, **payload},
                headers=self._headers,
                timeout=REQUEST_TIMEOUT,
                allow_redirects=False,
            ) as response:
                if response.status in (401, 403):
                    raise HearthAuthError
                if response.status != 200:
                    raise HearthConnectionError(f"status {response.status}")
                ended = False
                buffer = b""
                async for chunk in response.content.iter_any():
                    buffer += chunk
                    if len(buffer) > MAX_LINE and b"\n" not in buffer:
                        raise HearthProtocolError("line too long")
                    while b"\n" in buffer:
                        line, buffer = buffer.split(b"\n", 1)
                        if not line.strip():
                            continue
                        event = _parse(line)
                        yield event
                        if event["type"] == "end":
                            ended = True
                if buffer.strip():
                    event = _parse(buffer)
                    yield event
                    ended = ended or event["type"] == "end"
                if not ended:
                    raise HearthConnectionError("reply ended early")
        except HearthError:
            raise
        except (aiohttp.ClientError, TimeoutError) as err:
            raise HearthConnectionError(type(err).__name__) from None


def _parse(line: bytes) -> dict[str, Any]:
    try:
        event = json.loads(line)
    except ValueError:
        raise HearthProtocolError("invalid json") from None
    if not isinstance(event, dict) or event.get("type") not in (
        "start",
        "delta",
        "end",
    ):
        raise HearthProtocolError("unknown event")
    if event["type"] == "delta" and not isinstance(event.get("text"), str):
        raise HearthProtocolError("invalid delta")
    if event["type"] == "end" and not isinstance(event.get("speech_suffix"), str):
        raise HearthProtocolError("invalid end")
    return event
