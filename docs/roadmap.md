# Roadmap (non-commitments)

**0.1.0 implemented locally:** real Pi Durable/SQLite sessions and restart recovery; authenticated Ingress/local server; bounded, explicitly scoped HA reads; disabled-by-default exact light/switch approval ledger; offline demonstration and OpenAI API-key adapter. See [validation](validation.md) before testing in isolation.

**Next validation gate:** run both architecture container smokes and actual isolated Supervisor install/Ingress, mobile iframe/origin behavior, startup UID/data permissions, cold backup/restore, graceful shutdown and provider-paid inference under an approved test account. Neither deployment nor physical power loss has been tested here.

**Future proposals requiring design/review:** admin-configured OpenAI-compatible/local endpoint with SSRF and credential-origin controls; provider OAuth UX/secret storage; finer entity privacy, retention/export and practical token benchmarks. Later separate milestones could explore Assist/voice, planning-only config diffs followed by tested backups/rollback, or isolated external tools. None are current capabilities. Do not market “fully local” from the offline faux mode, claim token savings without a benchmark, or treat voice/config writes as enabled by this roadmap.
