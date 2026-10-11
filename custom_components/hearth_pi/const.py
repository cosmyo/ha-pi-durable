"""Constants for the Hearth Pi Assist integration."""

DOMAIN = "hearth_pi"

CONF_HOST = "host"
CONF_PORT = "port"
CONF_TOKEN = "token"
CONF_API = "api"

# The one Hearth Core API version this integration speaks.
API_VERSION = 1

# Spoken when Hearth cannot be reached or refuses the link. Fixed text; the
# link secret and raw errors are never spoken or logged.
SPEECH_UNREACHABLE = "Sorry, I can't reach Hearth right now."
SPEECH_LINK_REJECTED = (
    "Hearth didn't accept Home Assistant's link. Open Hearth to check Assist."
)
SPEECH_INTERRUPTED = "Sorry, I lost the connection to Hearth."
