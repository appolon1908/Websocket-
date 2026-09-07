# Browser provisioning contract

Request:

```json
{
  "campaign_id": "TEST_SYN",
  "endpoint": "6101",
  "browser_session_id": "opaque in-memory UUID"
}
```

Authentication is the existing Keycloak-backed HttpOnly session. The backend
must authorize subject, role, campaign, endpoint, and the single-browser
lease. It must rate-limit creation/refresh and audit only protected
references.

Response fields:

```text
session_id, binding_id, sip_uri, authorization_username,
ephemeral_password, websocket_url, ice_servers, expires_at, role,
campaign_id=TEST_SYN, endpoint=6101, environment=STAGING,
permitted_call_scope=["6000"]
```

`ice_servers` must contain bounded REST TURN credentials and the approved
`turns:vicidial-staging.codestra.agency:5349?transport=tcp` URL. The TURN
shared secret is never returned.

Refresh rotates credentials and preserves authorization binding. Revoke is
idempotent. Logout, user disablement, role/campaign change, duplicate browser,
expiry, and explicit destruction revoke the session. A response that is
expired, not staging, not endpoint 6101, not TEST_SYN, lacks TURN TLS, or
permits a non-echo destination is rejected client-side and must also be
rejected server-side.
