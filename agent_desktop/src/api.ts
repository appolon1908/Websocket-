import type { ProvisioningSession } from "./types";
import type { ProvisioningRequest } from "./phone";
import {assertPreviewSafe} from "./config/runtime";

const jsonHeaders = { "Content-Type": "application/json" };

export interface BrowserSession {
  username: string;
  subject: string;
  authenticated: boolean;
}

export async function browserSession(): Promise<BrowserSession> {
  const response = await fetch("/oauth2/userinfo", {
    method: "GET", credentials: "include", headers: { Accept: "application/json" },
  });
  if (!response.ok) throw new Error(`Browser authentication required (${response.status})`);
  const value = await response.json() as Record<string, unknown>;
  const username = [value.preferredUsername, value.preferred_username, value.user, value.email]
    .find(item => typeof item === "string" && item.length > 0);
  const subject = [value.sub, value.subject, value.email]
    .find(item => typeof item === "string" && item.length > 0);
  if (typeof username !== "string") throw new Error("Authenticated browser identity is incomplete");
  if (typeof subject !== "string") throw new Error("Authenticated browser subject is incomplete");
  return { username, subject, authenticated: true };
}

export async function provision(request: ProvisioningRequest): Promise<ProvisioningSession> {
  const response = await fetch("/webphone-api/v1/session", {
    method: "POST", headers: jsonHeaders, credentials: "include", signal: request.signal,
    body: JSON.stringify({ campaign_id: request.campaignId, endpoint: request.endpoint, browser_session_id: request.browserSessionId })
  });
  if (!response.ok) throw new Error(`Provisioning denied (${response.status})`);
  return response.json();
}

export async function refreshProvisioning(sessionId: string, browserSessionBinding: string): Promise<ProvisioningSession> {
  const response = await fetch("/webphone-api/v1/renew", {
    method: "POST", headers: jsonHeaders, credentials: "include",
    body: JSON.stringify({ session_id: sessionId, browser_session_binding: browserSessionBinding }),
  });
  if (!response.ok) throw new Error(`Credential refresh denied (${response.status})`);
  return response.json();
}

export async function revokeProvisioning(sessionId: string, browserSessionBinding: string): Promise<void> {
  const response = await fetch("/webphone-api/v1/revoke", {
    method: "POST", headers: jsonHeaders, credentials: "include",
    body: JSON.stringify({ session_id: sessionId, browser_session_binding: browserSessionBinding }),
  });
  if (!response.ok && response.status !== 404 && response.status !== 410) throw new Error(`Session revocation failed (${response.status})`);
}

export async function authorizeTransfer(action: string, callId: string, leadId: string): Promise<void> {
  assertPreviewSafe("Call transfer");
  const response = await fetch("/webphone-api/v1/transfers/request", {
    method: "POST", headers: jsonHeaders, credentials: "include",
    body: JSON.stringify({ action, call_id: callId, lead_id: leadId, campaign_id: "TEST_SYN" })
  });
  if (!response.ok) throw new Error("Transfer denied");
}
