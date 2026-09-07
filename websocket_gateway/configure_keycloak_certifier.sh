#!/usr/bin/env bash
set -euo pipefail

base_url="${KEYCLOAK_BASE_URL:-https://auth.codestra.co}"
realm="codestra"
admin_id="$(tr -d '\n' </etc/codestra/secrets/identity-platform/clients/codestra-realm-admin/client-id)"
admin_secret="$(tr -d '\n' </etc/codestra/secrets/identity-platform/clients/codestra-realm-admin/client-secret)"
token="$(curl -fsS -X POST "$base_url/realms/master/protocol/openid-connect/token" -d grant_type=client_credentials --data-urlencode client_id="$admin_id" --data-urlencode client_secret="$admin_secret" | jq -er .access_token)"
auth=(-H "Authorization: Bearer $token" -H 'Content-Type: application/json')

for role in telephony.webphone.use realtime.agent.connect; do
  code="$(curl -sS -o /dev/null -w '%{http_code}' "${auth[@]}" "$base_url/admin/realms/$realm/roles/$role")"
  if [[ "$code" == "404" ]]; then
    curl -fsS -o /dev/null -X POST "${auth[@]}" -d "{\"name\":\"$role\"}" "$base_url/admin/realms/$realm/roles"
  elif [[ "$code" != "200" ]]; then
    echo "role lookup failed: $role ($code)" >&2; exit 1
  fi
done

client_id="codestra-realtime-certifier"
client_uuid="$(curl -fsS "${auth[@]}" "$base_url/admin/realms/$realm/clients?clientId=$client_id" | jq -r '.[0].id // empty')"
if [[ -z "$client_uuid" ]]; then
  client_secret="$(openssl rand -hex 32)"
  install -d -m 0700 /etc/codestra/secrets/websocket-gateway
  umask 077
  openssl rand -out /etc/codestra/secrets/websocket-gateway/certifier_client_secret -hex 32
  client_secret="$(tr -d '\n' </etc/codestra/secrets/websocket-gateway/certifier_client_secret)"
  jq -n --arg id "$client_id" --arg secret "$client_secret" '{clientId:$id,secret:$secret,enabled:true,publicClient:false,serviceAccountsEnabled:true,standardFlowEnabled:false,directAccessGrantsEnabled:false,protocol:"openid-connect",attributes:{"access.token.lifespan":"300"}}' |
    curl -fsS -o /dev/null -X POST "${auth[@]}" --data-binary @- "$base_url/admin/realms/$realm/clients"
  client_uuid="$(curl -fsS "${auth[@]}" "$base_url/admin/realms/$realm/clients?clientId=$client_id" | jq -er '.[0].id')"
else
  client_secret="$(curl -fsS "${auth[@]}" -X POST "$base_url/admin/realms/$realm/clients/$client_uuid/client-secret" | jq -er .value)"
  umask 077
  printf '%s\n' "$client_secret" > /etc/codestra/secrets/websocket-gateway/certifier_client_secret
fi

add_mapper() {
  local name="$1" protocol_mapper="$2" config="$3"
  local exists
  exists="$(curl -fsS "${auth[@]}" "$base_url/admin/realms/$realm/clients/$client_uuid/protocol-mappers/models" | jq -r --arg name "$name" 'map(select(.name==$name))|length')"
  if [[ "$exists" == "0" ]]; then
    jq -n --arg name "$name" --arg mapper "$protocol_mapper" --argjson config "$config" '{name:$name,protocol:"openid-connect",protocolMapper:$mapper,consentRequired:false,config:$config}' |
      curl -fsS -o /dev/null -X POST "${auth[@]}" --data-binary @- "$base_url/admin/realms/$realm/clients/$client_uuid/protocol-mappers/models"
  fi
}

add_mapper audience oidc-audience-mapper '{"included.client.audience":"codestra-agent-desktop","access.token.claim":"true"}'
add_mapper realm_roles oidc-usermodel-realm-role-mapper '{"claim.name":"realm_access.roles","jsonType.label":"String","multivalued":"true","access.token.claim":"true"}'
add_mapper tenant oidc-hardcoded-claim-mapper '{"claim.name":"tenant_id","claim.value":"synthetic-tenant","jsonType.label":"String","access.token.claim":"true"}'
add_mapper business_unit oidc-hardcoded-claim-mapper '{"claim.name":"business_unit_id","claim.value":"TEST","jsonType.label":"String","access.token.claim":"true"}'
add_mapper agent oidc-hardcoded-claim-mapper '{"claim.name":"agent_id","claim.value":"CERT-AGENT-A","jsonType.label":"String","access.token.claim":"true"}'
add_mapper vicidial_user oidc-hardcoded-claim-mapper '{"claim.name":"vicidial_user","claim.value":"CERT6101","jsonType.label":"String","access.token.claim":"true"}'
add_mapper extension oidc-hardcoded-claim-mapper '{"claim.name":"extension","claim.value":"6101","jsonType.label":"String","access.token.claim":"true"}'
add_mapper campaigns oidc-hardcoded-claim-mapper '{"claim.name":"campaigns","claim.value":"[\"TEST_SYN\"]","jsonType.label":"JSON","access.token.claim":"true"}'

service_user_id="$(curl -fsS "${auth[@]}" "$base_url/admin/realms/$realm/clients/$client_uuid/service-account-user" | jq -er .id)"
for role in telephony.webphone.use realtime.agent.connect; do
  representation="$(curl -fsS "${auth[@]}" "$base_url/admin/realms/$realm/roles/$role")"
  current="$(curl -fsS "${auth[@]}" "$base_url/admin/realms/$realm/users/$service_user_id/role-mappings/realm" | jq -r --arg role "$role" 'map(select(.name==$role))|length')"
  if [[ "$current" == "0" ]]; then
    jq -n --argjson role "$representation" '[$role]' | curl -fsS -o /dev/null -X POST "${auth[@]}" --data-binary @- "$base_url/admin/realms/$realm/users/$service_user_id/role-mappings/realm"
  fi
done

chmod 0600 /etc/codestra/secrets/websocket-gateway/certifier_client_secret
echo "KEYCLOAK_REALTIME_CERTIFIER_CONFIGURED=PASS"
