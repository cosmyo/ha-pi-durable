"""Hearth Pi as a Home Assistant conversation agent (Assist).

Each turn sends Hearth the spoken text, the Assist context id (Hearth's
idempotency key), the speaker's Home Assistant user id when there is one,
and the satellite's device id. Hearth decides who is speaking and what they
may do; this agent offers no Home Assistant tools. Hearth's reply is
streamed into the chat log as it arrives, followed by the one sentence
Hearth's controller adds about approvals and results.
"""

from __future__ import annotations

import logging
import re
from collections.abc import AsyncGenerator
from typing import Any, Literal

from homeassistant.components import conversation
from homeassistant.const import MATCH_ALL
from homeassistant.core import HomeAssistant
from homeassistant.helpers import device_registry as dr
from homeassistant.helpers import intent
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback

from . import HearthConfigEntry
from .client import HearthAuthError, HearthClient, HearthError
from .const import (
    DOMAIN,
    SPEECH_INTERRUPTED,
    SPEECH_LINK_REJECTED,
    SPEECH_TOO_LONG,
    SPEECH_UNREACHABLE,
)

_LOGGER = logging.getLogger(__name__)


async def async_setup_entry(
    hass: HomeAssistant,
    entry: HearthConfigEntry,
    async_add_entities: AddConfigEntryEntitiesCallback,
) -> None:
    """Set up the Hearth conversation agent."""
    async_add_entities([HearthConversationEntity(entry)])


# Hearth's request limits (api 1); anything else is sent as "unknown".
MAX_TEXT = 2000
ID_PATTERN = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


def _payload(
    user_input: conversation.ConversationInput, conversation_id: str
) -> dict[str, Any]:
    return {
        "request_id": user_input.context.id,
        "text": user_input.text,
        "user_id": user_input.context.user_id,
        # Home Assistant may pass a caller-chosen conversation id through.
        "conversation_id": conversation_id
        if ID_PATTERN.match(conversation_id)
        else None,
        "device_id": user_input.device_id,
        "satellite_id": user_input.satellite_id,
        "language": user_input.language or "*",
        "extra_system_prompt": user_input.extra_system_prompt,
    }


class HearthConversationEntity(
    conversation.ConversationEntity, conversation.AbstractConversationAgent
):
    """Hearth Pi conversation agent."""

    _attr_has_entity_name = True
    _attr_name = None
    _attr_supports_streaming = True
    # Hearth can change the home (always through its own approvals), so HA
    # offers "Prefer handling commands locally" for this agent.
    _attr_supported_features = conversation.ConversationEntityFeature.CONTROL

    def __init__(self, entry: HearthConfigEntry) -> None:
        """Initialize the agent."""
        self.entry = entry
        self._attr_unique_id = entry.entry_id
        self._attr_device_info = dr.DeviceInfo(
            identifiers={(DOMAIN, entry.entry_id)},
            name=entry.title,
            manufacturer="Hearth Pi",
            entry_type=dr.DeviceEntryType.SERVICE,
        )

    @property
    def supported_languages(self) -> list[str] | Literal["*"]:
        """Hearth's model replies in the speaker's language."""
        return MATCH_ALL

    @property
    def _client(self) -> HearthClient:
        return self.entry.runtime_data

    async def _async_handle_message(
        self,
        user_input: conversation.ConversationInput,
        chat_log: conversation.ChatLog,
    ) -> conversation.ConversationResult:
        """Send one turn to Hearth and stream its reply into the chat log."""
        if len(user_input.text) > MAX_TEXT or len(user_input.text.encode()) > 6000:
            response = intent.IntentResponse(language=user_input.language)
            response.async_set_error(
                intent.IntentResponseErrorCode.UNKNOWN, SPEECH_TOO_LONG
            )
            return conversation.ConversationResult(
                response=response, conversation_id=chat_log.conversation_id
            )
        state: dict[str, Any] = {"text": "", "end": None, "error": None}
        payload = _payload(user_input, chat_log.conversation_id)

        async def deltas() -> AsyncGenerator[conversation.AssistantContentDeltaDict]:
            yield {"role": "assistant"}
            try:
                async for event in self._client.async_converse(payload):
                    if event["type"] == "delta" and event["text"]:
                        state["text"] += event["text"]
                        yield {"content": event["text"]}
                    elif event["type"] == "end":
                        state["end"] = event
                        suffix = event["speech_suffix"].strip()
                        if suffix:
                            piece = f" {suffix}" if state["text"] else suffix
                            state["text"] += piece
                            yield {"content": piece}
            except HearthError as err:
                state["error"] = err
                if state["text"]:
                    piece = f" {SPEECH_INTERRUPTED}"
                    state["text"] += piece
                    yield {"content": piece}

        if hasattr(chat_log, "async_add_delta_content_stream"):
            async for _content in chat_log.async_add_delta_content_stream(
                self.entity_id, deltas()
            ):
                pass
        else:
            # Older Home Assistant without the delta stream: same events,
            # one assistant message at the end.
            async for _delta in deltas():
                pass
            if state["text"]:
                chat_log.async_add_assistant_content_without_tools(
                    conversation.AssistantContent(
                        agent_id=self.entity_id, content=state["text"]
                    )
                )

        response = intent.IntentResponse(language=user_input.language)
        error = state["error"]
        if error is not None and not state["text"]:
            _LOGGER.warning("Hearth could not answer (%s)", type(error).__name__)
            response.async_set_error(
                intent.IntentResponseErrorCode.UNKNOWN,
                SPEECH_LINK_REJECTED
                if isinstance(error, HearthAuthError)
                else SPEECH_UNREACHABLE,
            )
            return conversation.ConversationResult(
                response=response, conversation_id=chat_log.conversation_id
            )
        response.async_set_speech(state["text"])
        end = state["end"] or {}
        return conversation.ConversationResult(
            response=response,
            conversation_id=chat_log.conversation_id,
            continue_conversation=bool(end.get("continue_conversation")),
        )
