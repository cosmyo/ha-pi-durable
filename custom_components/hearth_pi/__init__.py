"""Hearth Pi: use the Hearth Pi add-on as a Home Assistant Assist agent.

Hearth keeps its own durable chats, Home permissions, risk classifier and
approvals. This integration only passes the spoken text and the speaker's
Home Assistant identity to Hearth and streams Hearth's reply back. It offers
no Home Assistant LLM tools of its own.
"""

from __future__ import annotations

from homeassistant.config_entries import ConfigEntry
from homeassistant.const import Platform
from homeassistant.core import HomeAssistant
from homeassistant.helpers.aiohttp_client import async_get_clientsession

from .client import HearthClient
from .const import CONF_HOST, CONF_PORT, CONF_TOKEN

PLATFORMS = [Platform.CONVERSATION]

type HearthConfigEntry = ConfigEntry[HearthClient]


async def async_setup_entry(hass: HomeAssistant, entry: HearthConfigEntry) -> bool:
    """Set up Hearth Pi from a config entry."""
    entry.runtime_data = HearthClient(
        async_get_clientsession(hass),
        entry.data[CONF_HOST],
        entry.data[CONF_PORT],
        entry.data[CONF_TOKEN],
    )
    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    return True


async def async_unload_entry(hass: HomeAssistant, entry: HearthConfigEntry) -> bool:
    """Unload a config entry."""
    return await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
