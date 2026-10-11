"""Diagnostics for Hearth Pi. The link secret is always redacted."""

from __future__ import annotations

from typing import Any

from homeassistant.components.diagnostics import async_redact_data
from homeassistant.core import HomeAssistant

from . import HearthConfigEntry
from .client import HearthError
from .const import CONF_TOKEN

TO_REDACT = {CONF_TOKEN, "Authorization"}


async def async_get_config_entry_diagnostics(
    hass: HomeAssistant, entry: HearthConfigEntry
) -> dict[str, Any]:
    """Return diagnostics for a config entry."""
    try:
        info: dict[str, Any] | str = await entry.runtime_data.async_info()
    except HearthError as err:
        info = type(err).__name__
    return {
        "entry": async_redact_data(dict(entry.data), TO_REDACT),
        "hearth": info,
    }
