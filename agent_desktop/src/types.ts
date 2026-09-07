export type AgentRole = "SETTER" | "CLOSER" | "SUPERVISOR" | "ADMINISTRATOR";
export type RegistrationState = "Offline" | "Connecting" | "Registered" | "Recovering" | "Failed";
export type CallState = "Idle" | "Ringing" | "Active" | "Held";

export interface ProvisioningSession {
  session_id: string;
  binding_id: string;
  sip_uri: string;
  authorization_username: string;
  ephemeral_password: string;
  websocket_url: string;
  ice_servers: RTCIceServer[];
  expires_at: string;
  role: AgentRole;
  campaign_id: "TEST_SYN";
  endpoint: "6101";
  environment: "STAGING";
  permitted_call_scope: readonly ["6000"];
}

export interface NetworkMetrics { rtt: number; jitter: number; loss: number; codec: string; }
