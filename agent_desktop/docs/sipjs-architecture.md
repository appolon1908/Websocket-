# SIP.js staging phone architecture

The staging Agent Desktop selects exactly one visible phone mode:

- `SIPJS_STAGING` only when the build environment is `staging`, SIP and WebRTC
  flags are enabled, and safe mode is explicitly disabled;
- `DIAGNOSTIC_FAIL_CLOSED` otherwise;
- `DISABLED` is reserved for server policy.

`SipJsPhone` owns the SIP.js `UserAgent`, `Registerer`, current
`Invitation`/`Inviter`, short-lived credential lifecycle, local and remote
media streams, timers, and state subscriptions. It never silently replaces a
failed SIP.js adapter with DiagnosticPhone.

The browser requests a provisioning session using its authenticated cookie and
an in-memory browser binding ID. The response must bind the Keycloak subject,
 desktop session, role, `TEST_SYN` campaign, endpoint `6101`, expiry, and
single active browser. Only WSS, TURN TLS, and echo extension `6000` are
accepted by the frontend as an additional defense. The server remains
authoritative.

Credentials exist only in the adapter instance. They are absent from state
snapshots, diagnostics, URLs, browser storage, and logs. Refresh replaces the
entire SIP connection. Revocation, logout/destroy, expiry, and fatal cleanup
stop media, unregister, stop the UserAgent, and clear the credential object.

Remote media is attached to a dedicated autoplay audio element. The adapter
records only candidate type, ICE/connection states, codec, packet counters,
jitter, and RTT. It does not log candidate addresses.

Transfers and external destinations are not implemented. `dial()` permits
only extension `6000` when it is also present in the server-provided call
scope.
