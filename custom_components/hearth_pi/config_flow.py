"""Config flow for Hearth Pi: set up only from the add-on's Supervisor discovery."""

from __future__ import annotations

import re
from typing import Any

from homeassistant.config_entries import ConfigFlow, ConfigFlowResult
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.service_info.hassio import HassioServiceInfo

from .client import HearthAuthError, HearthClient, HearthError
from .const import API_VERSION, CONF_HOST, CONF_PORT, CONF_TOKEN, DOMAIN

HOST_PATTERN = re.compile(r"^[a-z0-9][a-z0-9.-]{0,63}$")
TOKEN_PATTERN = re.compile(r"^[A-Za-z0-9_-]{43}$")


def _discovered(config: dict[str, Any]) -> dict[str, Any] | None:
    """The link Hearth published, or None when it is not a valid one."""
    host = config.get(CONF_HOST)
    port = config.get(CONF_PORT)
    token = config.get(CONF_TOKEN)
    if (
        config.get("api") != API_VERSION
        or not isinstance(host, str)
        or not HOST_PATTERN.match(host)
        or not isinstance(port, int)
        or isinstance(port, bool)
        or not 1 <= port <= 65535
        or not isinstance(token, str)
        or not TOKEN_PATTERN.match(token)
    ):
        return None
    return {CONF_HOST: host, CONF_PORT: port, CONF_TOKEN: token}


class HearthConfigFlow(ConfigFlow, domain=DOMAIN):
    """Handle a config flow for Hearth Pi."""

    VERSION = 1

    def __init__(self) -> None:
        """Initialize the flow."""
        self._link: dict[str, Any] | None = None
        self._addon = "Hearth Pi"

    async def async_step_user(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        """Manual setup is not offered: the link secret comes from discovery."""
        return self.async_abort(reason="use_discovery")

    async def async_step_hassio(
        self, discovery_info: HassioServiceInfo
    ) -> ConfigFlowResult:
        """Receive the Core link from the Hearth Pi add-on."""
        link = _discovered(discovery_info.config)
        if link is None:
            return self.async_abort(reason="invalid_discovery")
        # One entry per discovery message (Supervisor keeps its id when the
        # add-on publishes a new secret). A rediscovery of a configured
        # entry updates its host, port and secret and reloads it.
        await self.async_set_unique_id(discovery_info.uuid)
        self._abort_if_unique_id_configured(updates=link)
        self._link = link
        self._addon = discovery_info.name or "Hearth Pi"
        self.context["title_placeholders"] = {"addon": self._addon}
        return await self.async_step_hassio_confirm()

    async def async_step_hassio_confirm(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        """Confirm linking Home Assistant Assist to Hearth."""
        assert self._link is not None
        errors: dict[str, str] = {}
        if user_input is not None:
            client = HearthClient(
                async_get_clientsession(self.hass),
                self._link[CONF_HOST],
                self._link[CONF_PORT],
                self._link[CONF_TOKEN],
            )
            try:
                await client.async_info()
            except HearthAuthError:
                errors["base"] = "invalid_auth"
            except HearthError:
                errors["base"] = "cannot_connect"
            else:
                return self.async_create_entry(title=self._addon, data=self._link)
        return self.async_show_form(
            step_id="hassio_confirm",
            description_placeholders={"addon": self._addon},
            errors=errors,
        )
