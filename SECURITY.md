# Security policy

Hearth Pi 0.1.0 is experimental, not audited or approved for safety-critical control. See [the threat model](docs/security.md). Do not test against a live Home Assistant system without its owner's authorization.

## Reporting privately

No public security mailbox or hosted private-reporting endpoint has been established. **Do not include credentials, access tokens, private addresses, personal entity names or exploit details in a public issue.** Until a private reporting channel is published, retain sensitive details and request a secure channel from maintainers through a non-sensitive issue if a public issue tracker becomes available. There is no response-time or coordinated-disclosure SLA yet. If an issue presents immediate risk, disable service actions and stop the App while preserving the private data for investigation.

Provide the affected version/commit, synthetic reproduction, expected versus observed outcome and impact after a private channel is arranged. Never paste `/data`, provider keys, Supervisor tokens, or real transcripts.

Supported security-fix policy has not been established; 0.1.0 is the only initial version. Updates are not automatically delivered from this source tree.
