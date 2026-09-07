const enabled = (name: string, fallback = false): boolean => {
  const value = import.meta.env[name];
  return value === undefined ? fallback : value === "true";
};

export const runtime = Object.freeze({
  environment: import.meta.env.VITE_APP_ENV || "preview",
  safeMode: enabled("VITE_SAFE_MODE", true),
  mockMode: enabled("VITE_MOCK_MODE", true),
  liveIntegrationsDisabled: enabled("VITE_DISABLE_LIVE_INTEGRATIONS", true),
  sipEnabled: enabled("VITE_SIP_ENABLED"),
  webRtcEnabled: enabled("VITE_WEBRTC_ENABLED"),
  vicidialEnabled: enabled("VITE_VICIDIAL_ENABLED"),
  odooEnabled: enabled("VITE_ODOO_ENABLED"),
  n8nEnabled: enabled("VITE_N8N_ENABLED"),
  testSynOnly: enabled("VITE_TEST_SYN_ONLY", true),
  productionPstn: enabled("VITE_PRODUCTION_PSTN", false),
  wssUrl: import.meta.env.VITE_WSS_URL || "wss://wss.codestra.agency:8089/ws",
});

export function assertPreviewSafe(action: string): void {
  if (runtime.safeMode || runtime.liveIntegrationsDisabled) {
    throw new Error(`${action} is disabled in Preview Mode`);
  }
}
