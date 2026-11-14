# Preserve uncertain commercial save recovery

Requirements: WOS-CORE-003/005, WOS-NFR-OBS-005 and WOS-NFR-UX-005; COMMERCIALS_REVENUE_MARGIN_SPEC.md immutable commercial evidence and server-authoritative command behavior remain unchanged.

The existing commercial editor locks submission after uncertain save/409 outcomes and instructs users to reload, but Discard draft clears that lock immediately. Protect discard and retained callbacks while uncertainty remains. Explicit successful scoped workspace reload is the existing recovery path; failed reload must not enable new commands. Do not introduce automatic retries or change decimal calculations, authorization, idempotency or commercial history.

Acceptance: reproduce the enabled-discard gap in the actual React/service controlled-transport browser harness; prevent discard, retained callbacks and new drafts after503/network/malformed acknowledgement and409; prove failed reload stays unavailable and successful reload restores normal creation; preserve ordinary unsaved discard and existing browser/API journeys. Update traceability and operations; run relevant type/lint/build/contracts. No migration or dependencies. Forward UI correction preferred; reverting restores uncertainty bypass. No production release claim.
