# Phone state machine

States:

`UNINITIALIZED → DISCONNECTED → PROVISIONING → CONNECTING → CONNECTED →
REGISTERING → REGISTERED`

Call branches:

- outbound: `REGISTERED → DIALING → RINGING → ACTIVE → HELD/ACTIVE →
  REGISTERED`;
- inbound: `REGISTERED → INCOMING → ACTIVE → HELD/ACTIVE → REGISTERED`.

Recovery and terminal branches:

- signaling/network loss: `REGISTERED|ACTIVE|HELD → RECONNECTING`;
- explicit cleanup: any live state → `DISCONNECTING → DISCONNECTED`;
- credential deadline: any live state → `EXPIRED`;
- server/logout revocation: any live state → `REVOKED`;
- unknown or unmapped failure: `ERROR`, never success.

Concurrent connect, registration, dial, and answer operations are rejected.
Incoming duplicates are rejected. Invalid controls are disabled in the UI and
rejected again by the adapter.
