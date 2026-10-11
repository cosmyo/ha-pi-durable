"""Fixtures for the Hearth Pi integration tests."""

from __future__ import annotations

from collections.abc import AsyncIterator

from aiohttp import web
from fakes import FakeHearth
from homeassistant.core import HomeAssistant
from homeassistant.setup import async_setup_component
import pytest


@pytest.fixture(autouse=True)
async def setup_core(
    hass: HomeAssistant, enable_custom_integrations: None
) -> None:
    """Load custom_components/hearth_pi next to Home Assistant's core setup."""
    assert await async_setup_component(hass, "homeassistant", {})


@pytest.fixture
async def hearth(socket_enabled: None) -> AsyncIterator[FakeHearth]:
    """Run the fake Hearth listener."""
    fake = FakeHearth()
    app = web.Application()
    app.router.add_get("/core/v1/info", fake.info)
    app.router.add_post("/core/v1/conversation", fake.conversation)
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", 0)
    await site.start()
    fake.port = site._server.sockets[0].getsockname()[1]  # noqa: SLF001
    yield fake
    await runner.cleanup()
