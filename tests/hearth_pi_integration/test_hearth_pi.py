"""Tests for the Hearth Pi Assist integration against a fake Hearth listener."""

from __future__ import annotations

from typing import Any

from homeassistant.components import conversation
from homeassistant.config_entries import SOURCE_HASSIO, SOURCE_USER
from homeassistant.core import Context, HomeAssistant
from homeassistant.data_entry_flow import FlowResultType
from homeassistant.helpers import intent
from homeassistant.helpers.service_info.hassio import HassioServiceInfo
from pytest_homeassistant_custom_component.common import MockConfigEntry
from pytest_homeassistant_custom_component.components.diagnostics import (
    get_diagnostics_for_config_entry,
)

from custom_components.hearth_pi.client import (
    HearthClient,
    HearthConnectionError,
    HearthProtocolError,
    _parse,
)
from custom_components.hearth_pi.const import (
    DOMAIN,
    SPEECH_INTERRUPTED,
    SPEECH_LINK_REJECTED,
    SPEECH_UNREACHABLE,
)

from fakes import OTHER_TOKEN, TOKEN, FakeHearth

UUID = "0123456789abcdef0123456789abcdef"
OWNER = "user-owner-a"


def discovery(fake: FakeHearth, token: str = TOKEN, **extra: Any) -> HassioServiceInfo:
    """A Supervisor discovery message as Home Assistant passes it on."""
    return HassioServiceInfo(
        config={
            "host": "127.0.0.1",
            "port": fake.port,
            "api": 1,
            "token": token,
            "addon": "Hearth Pi",
            **extra,
        },
        name="Hearth Pi",
        slug="abc12345_hearth_pi",
        uuid=UUID,
    )


async def setup_entry(hass: HomeAssistant, fake: FakeHearth) -> MockConfigEntry:
    """A linked Hearth entry with its conversation agent."""
    entry = MockConfigEntry(
        domain=DOMAIN,
        title="Hearth Pi",
        unique_id=UUID,
        data={"host": "127.0.0.1", "port": fake.port, "token": TOKEN},
    )
    entry.add_to_hass(hass)
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    return entry


def agent_id(hass: HomeAssistant) -> str:
    """The conversation entity of the one Hearth entry."""
    [entity_id] = [
        state.entity_id
        for state in hass.states.async_all("conversation")
        if state.entity_id != "conversation.home_assistant"
        and state.state != "unavailable"
    ]
    return entity_id


async def test_discovery_confirm_creates_entry(
    hass: HomeAssistant, hearth: FakeHearth
) -> None:
    """Discovery shows a confirm step; confirming checks the link once."""
    result = await hass.config_entries.flow.async_init(
        DOMAIN, context={"source": SOURCE_HASSIO}, data=discovery(hearth)
    )
    assert result["type"] is FlowResultType.FORM
    assert result["step_id"] == "hassio_confirm"
    assert hearth.headers == []
    result = await hass.config_entries.flow.async_configure(result["flow_id"], {})
    assert result["type"] is FlowResultType.CREATE_ENTRY
    assert result["title"] == "Hearth Pi"
    assert result["data"] == {"host": "127.0.0.1", "port": hearth.port, "token": TOKEN}
    assert result["result"].unique_id == UUID
    assert hearth.headers[0]["Authorization"] == f"Bearer {TOKEN}"
    assert "Origin" not in hearth.headers[0]
    await hass.async_block_till_done()
    assert agent_id(hass).startswith("conversation.")


async def test_rediscovery_updates_the_secret(
    hass: HomeAssistant, hearth: FakeHearth
) -> None:
    """A rotated secret arrives as a new discovery and updates the entry."""
    entry = await setup_entry(hass, hearth)
    hearth.token = OTHER_TOKEN
    result = await hass.config_entries.flow.async_init(
        DOMAIN,
        context={"source": SOURCE_HASSIO},
        data=discovery(hearth, token=OTHER_TOKEN),
    )
    assert result["type"] is FlowResultType.ABORT
    assert result["reason"] == "already_configured"
    await hass.async_block_till_done()
    assert entry.data["token"] == OTHER_TOKEN
    hearth.events = [
        {"type": "start"},
        {"type": "delta", "text": "Hello."},
        {
            "type": "end",
            "status": "done",
            "speech_suffix": "",
            "continue_conversation": False,
            "proposals": [],
        },
    ]
    result = await conversation.async_converse(
        hass, "Hi", None, Context(user_id=OWNER), agent_id=agent_id(hass)
    )
    assert result.response.speech["plain"]["speech"] == "Hello."


async def test_invalid_discovery_and_manual_setup_abort(
    hass: HomeAssistant, hearth: FakeHearth
) -> None:
    """Only a well-formed api 1 link is accepted; no manual setup."""
    for bad in (
        discovery(hearth, token="short"),
        discovery(hearth, api=2),
        HassioServiceInfo(
            config={"host": "bad host", "port": 1, "api": 1, "token": TOKEN},
            name="Hearth Pi",
            slug="abc12345_hearth_pi",
            uuid=UUID,
        ),
    ):
        result = await hass.config_entries.flow.async_init(
            DOMAIN, context={"source": SOURCE_HASSIO}, data=bad
        )
        assert result["type"] is FlowResultType.ABORT
        assert result["reason"] == "invalid_discovery"
    result = await hass.config_entries.flow.async_init(
        DOMAIN, context={"source": SOURCE_USER}
    )
    assert result["type"] is FlowResultType.ABORT
    assert result["reason"] == "use_discovery"


async def test_confirm_errors(hass: HomeAssistant, hearth: FakeHearth) -> None:
    """A refused secret and an unreachable Hearth show errors, not an entry."""
    result = await hass.config_entries.flow.async_init(
        DOMAIN,
        context={"source": SOURCE_HASSIO},
        data=discovery(hearth, token=OTHER_TOKEN),
    )
    result = await hass.config_entries.flow.async_configure(result["flow_id"], {})
    assert result["type"] is FlowResultType.FORM
    assert result["errors"] == {"base": "invalid_auth"}
    info = discovery(hearth)
    info.config["port"] = 1
    info.uuid = "f" * 32
    result = await hass.config_entries.flow.async_init(
        DOMAIN, context={"source": SOURCE_HASSIO}, data=info
    )
    result = await hass.config_entries.flow.async_configure(result["flow_id"], {})
    assert result["errors"] == {"base": "cannot_connect"}


async def test_conversation_streams_reply_and_closing_sentence(
    hass: HomeAssistant, hearth: FakeHearth
) -> None:
    """Deltas and Hearth's closing sentence become the spoken reply."""
    await setup_entry(hass, hearth)
    hearth.events = [
        {"type": "start"},
        {"type": "delta", "text": "Okay, "},
        {"type": "delta", "text": "the lamp."},
        {
            "type": "end",
            "status": "done",
            "speech_suffix": "It's waiting for your approval in Hearth.",
            "continue_conversation": False,
            "proposals": [{"risk": "low", "status": "pending", "notified": False}],
        },
    ]
    context = Context(user_id=OWNER)
    result = await conversation.async_converse(
        hass,
        "Turn on the lamp",
        None,
        context,
        agent_id=agent_id(hass),
        device_id="a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6",
    )
    assert result.response.response_type is intent.IntentResponseType.ACTION_DONE
    assert (
        result.response.speech["plain"]["speech"]
        == "Okay, the lamp. It's waiting for your approval in Hearth."
    )
    assert result.continue_conversation is False
    [sent] = hearth.requests
    assert sent["api"] == 1
    assert sent["request_id"] == context.id
    assert sent["user_id"] == OWNER
    assert sent["text"] == "Turn on the lamp"
    assert sent["device_id"] == "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6"
    assert sent["conversation_id"] == result.conversation_id
    assert sent["extra_system_prompt"] is None
    assert "Origin" not in hearth.headers[-1]
    # The same Home Assistant conversation continues with the same id.
    hearth.events = [
        {"type": "start"},
        {"type": "delta", "text": "Which lamp?"},
        {
            "type": "end",
            "status": "done",
            "speech_suffix": "",
            "continue_conversation": True,
            "proposals": [],
        },
    ]
    again = await conversation.async_converse(
        hass,
        "The lamp",
        result.conversation_id,
        Context(user_id=OWNER),
        agent_id=agent_id(hass),
    )
    assert again.continue_conversation is True
    assert hearth.requests[-1]["conversation_id"] == result.conversation_id


async def test_conversation_refusal_is_spoken(
    hass: HomeAssistant, hearth: FakeHearth
) -> None:
    """A refused turn (no speaker) speaks Hearth's line."""
    await setup_entry(hass, hearth)
    hearth.events = [
        {"type": "start"},
        {
            "type": "end",
            "status": "refused",
            "speech_suffix": "Sorry, Hearth needs to know who is speaking.",
            "continue_conversation": False,
            "proposals": [],
        },
    ]
    result = await conversation.async_converse(
        hass, "Unlock the door", None, Context(), agent_id=agent_id(hass)
    )
    assert (
        result.response.speech["plain"]["speech"]
        == "Sorry, Hearth needs to know who is speaking."
    )
    assert hearth.requests[-1]["user_id"] is None


async def test_conversation_errors(hass: HomeAssistant, hearth: FakeHearth) -> None:
    """A refused link, an unreachable Hearth and a cut reply are spoken safely."""
    entry = await setup_entry(hass, hearth)
    hearth.token = OTHER_TOKEN
    result = await conversation.async_converse(
        hass, "Hi", None, Context(user_id=OWNER), agent_id=agent_id(hass)
    )
    assert result.response.response_type is intent.IntentResponseType.ERROR
    assert result.response.speech["plain"]["speech"] == SPEECH_LINK_REJECTED
    hearth.token = TOKEN
    hearth.events = [
        {"type": "start"},
        {"type": "delta", "text": "Let me check"},
        {"type": "end", "status": "done", "speech_suffix": ""},
    ]
    hearth.cut_after = 2
    result = await conversation.async_converse(
        hass, "Hi", None, Context(user_id=OWNER), agent_id=agent_id(hass)
    )
    assert (
        result.response.speech["plain"]["speech"]
        == f"Let me check {SPEECH_INTERRUPTED}"
    )
    await hass.config_entries.async_unload(entry.entry_id)
    entry2 = MockConfigEntry(
        domain=DOMAIN,
        title="Hearth Pi",
        unique_id="other",
        data={"host": "127.0.0.1", "port": 1, "token": TOKEN},
    )
    entry2.add_to_hass(hass)
    assert await hass.config_entries.async_setup(entry2.entry_id)
    await hass.async_block_till_done()
    result = await conversation.async_converse(
        hass, "Hi", None, Context(user_id=OWNER), agent_id=agent_id(hass)
    )
    assert result.response.speech["plain"]["speech"] == SPEECH_UNREACHABLE


async def test_diagnostics_redact_the_secret(
    hass: HomeAssistant, hass_client: Any, hearth: FakeHearth
) -> None:
    """Diagnostics never contain the link secret."""
    entry = await setup_entry(hass, hearth)
    data = await get_diagnostics_for_config_entry(hass, hass_client, entry)
    assert TOKEN not in str(data)
    assert data["entry"]["token"] == "**REDACTED**"
    assert data["hearth"]["api"] == 1


def test_client_never_shows_the_secret() -> None:
    """The client's repr has no secret; malformed events are refused."""
    client = HearthClient(None, "hearth", 8098, TOKEN)  # type: ignore[arg-type]
    assert TOKEN not in repr(client)
    for line in (b"not json", b"[]", b'{"type":"other"}', b'{"type":"delta"}'):
        try:
            _parse(line)
        except HearthProtocolError:
            continue
        raise AssertionError(line)
    assert _parse(b'{"type":"delta","text":"x"}')["text"] == "x"
    assert issubclass(HearthConnectionError, Exception)
