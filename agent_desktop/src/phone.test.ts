// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DiagnosticPhone, PhoneError, SipJsPhone, phoneErrorCodes, phoneStates, type ProvisioningRequest } from "./phone";
import type { ProvisioningSession } from "./types";

class Emitter<T> {
  listeners = new Set<(value: T) => void>();
  addListener = (listener: (value: T) => void) => this.listeners.add(listener);
  removeListener = (listener: (value: T) => void) => this.listeners.delete(listener);
  emit(value: T) { this.listeners.forEach(listener => listener(value)); }
}

const track = () => ({ kind: "audio", enabled: true, readyState: "live", stop: vi.fn(), getSettings: () => ({ deviceId: "mic-1" }) });
const stream = () => {
  const audio = track();
  return { getTracks: () => [audio], getAudioTracks: () => [audio] } as unknown as MediaStream;
};
const session = (overrides: Partial<ProvisioningSession> = {}): ProvisioningSession => ({
  session_id: "session-reference",
  binding_id: "browser-binding",
  sip_uri: "sip:6101@dialer.codestra.agency",
  authorization_username: "temporary-user",
  ephemeral_password: "memory-only-credential",
  websocket_url: "wss://wss.codestra.agency:8089/ws",
  ice_servers: [{ urls: ["turns:vicidial-staging.codestra.agency:5349?transport=tcp"], username: "temporary-turn", credential: "temporary-turn-credential" }],
  expires_at: new Date(Date.now() + 300_000).toISOString(),
  role: "SETTER",
  campaign_id: "TEST_SYN",
  endpoint: "6101",
  environment: "STAGING",
  permitted_call_scope: ["6000"],
  ...overrides,
});
const request: ProvisioningRequest = { campaignId: "TEST_SYN", endpoint: "6101", browserSessionId: "browser-binding" };

function harness(overrides: Record<string, unknown> = {}) {
  const transportChange = new Emitter<unknown>();
  const registrationChange = new Emitter<unknown>();
  const ua = {
    transport: { stateChange: transportChange },
    start: vi.fn(async () => transportChange.emit("Connected")),
    stop: vi.fn(async () => undefined),
  };
  const registerer = {
    stateChange: registrationChange,
    register: vi.fn(async () => registrationChange.emit("Registered")),
    unregister: vi.fn(async () => undefined),
  };
  const mediaDevices = {
    getUserMedia: vi.fn(async () => stream()),
    enumerateDevices: vi.fn(async () => []),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
    getSupportedConstraints: vi.fn(() => ({})),
    getDisplayMedia: vi.fn(),
    ondevicechange: null,
  } as unknown as MediaDevices;
  const deps = {
    provision: vi.fn(async () => session()),
    refresh: vi.fn(async () => session({ session_id: "refreshed" })),
    revoke: vi.fn(async () => undefined),
    userAgentFactory: vi.fn(() => ua),
    registererFactory: vi.fn(() => registerer),
    mediaDevices,
    ...overrides,
  };
  return { phone: new SipJsPhone(deps as never), deps, ua, registerer, mediaDevices };
}

beforeEach(() => {
  vi.stubGlobal("RTCPeerConnection", class {});
  vi.stubGlobal("MediaStream", class {
    tracks: MediaStreamTrack[] = [];
    addTrack(value: MediaStreamTrack) { this.tracks.push(value); }
    getTracks() { return this.tracks; }
  });
});

describe("phone contract", () => {
  it("declares every required state", () => expect(phoneStates).toHaveLength(18));
  it("declares structured error codes", () => expect(phoneErrorCodes).toContain("TRANSFER_PROHIBITION"));
  it("initializes successfully", async () => {
    const { phone } = harness(); await phone.initialize(); expect(phone.getSnapshot().state).toBe("DISCONNECTED");
  });
  it("provisions successfully without browser persistence", async () => {
    const { phone } = harness(); await phone.initialize(); await phone.requestProvisioningSession(request);
    expect(phone.getSnapshot().state).toBe("PROVISIONED");
    expect(localStorage.length + sessionStorage.length).toBe(0);
  });
  it("rejects provisioning authentication failure", async () => {
    const { phone } = harness({ provision: vi.fn(async () => { throw new Error("401"); }) }); await phone.initialize();
    await expect(phone.requestProvisioningSession(request)).rejects.toMatchObject({ code: "PROVISIONING_FAILURE" });
  });
  it("rejects authorization failure", async () => {
    const { phone } = harness(); await phone.initialize();
    await expect(phone.requestProvisioningSession({ ...request, campaignId: "PRODUCTION" })).rejects.toMatchObject({ code: "UNAUTHORIZED_CAMPAIGN" });
  });
  it("rejects expired credentials", async () => {
    const { phone } = harness({ provision: vi.fn(async () => session({ expires_at: new Date(Date.now() - 1000).toISOString() })) }); await phone.initialize();
    await expect(phone.requestProvisioningSession(request)).rejects.toMatchObject({ code: "CREDENTIAL_EXPIRATION" });
  });
  it("handles revoked credentials", async () => {
    const { phone, deps } = harness(); await phone.initialize(); await phone.requestProvisioningSession(request); await phone.revokeSession();
    expect(deps.revoke).toHaveBeenCalled(); expect(phone.getSnapshot().state).toBe("REVOKED");
  });
  it("registers successfully", async () => {
    const { phone } = harness(); await phone.initialize(); await phone.requestProvisioningSession(request); await phone.connect(); await phone.register();
    expect(phone.getSnapshot().state).toBe("REGISTERED");
  });
  it("reports WSS failure", async () => {
    const { phone } = harness({ userAgentFactory: vi.fn(() => ({ transport: { stateChange: new Emitter() }, start: vi.fn(async () => { throw new Error("wss"); }), stop: vi.fn(async () => undefined) })) });
    await phone.initialize(); await phone.requestProvisioningSession(request);
    await expect(phone.connect()).rejects.toMatchObject({ code: "WSS_FAILURE" });
  });
  it("rejects duplicate connect", async () => {
    const { phone } = harness(); await phone.initialize(); await phone.requestProvisioningSession(request); await phone.connect();
    await expect(phone.connect()).rejects.toMatchObject({ code: "DUPLICATE_REGISTRATION" });
  });
  it("rejects duplicate registration", async () => {
    const { phone } = harness(); await phone.initialize(); await phone.requestProvisioningSession(request); await phone.connect(); await phone.register();
    await expect(phone.register()).rejects.toMatchObject({ code: "DUPLICATE_REGISTRATION" });
  });
  it("refreshes short-lived credentials", async () => {
    const { phone, deps } = harness(); await phone.initialize(); await phone.requestProvisioningSession(request); await phone.connect();
    await phone.refreshCredentials(); expect(deps.refresh).toHaveBeenCalledWith("session-reference", "browser-binding");
  });
  it("rejects outbound destinations except echo 6000", async () => {
    const { phone } = harness(); await phone.initialize(); await phone.requestProvisioningSession(request); await phone.connect(); await phone.register();
    await expect(phone.dial("18095550100")).rejects.toMatchObject({ code: "CALL_ROUTE_REJECTION" });
  });
  it.each(["answer", "reject", "hangup", "hold", "resume", "mute", "unmute", "sendDTMF"] as const)("%s fails closed outside a valid call state", async method => {
    const { phone } = harness(); await phone.initialize();
    const call = method === "sendDTMF" ? phone.sendDTMF("1") : phone[method]();
    if (method === "hangup") await expect(call).resolves.toBeUndefined();
    else await expect(call).rejects.toBeInstanceOf(PhoneError);
  });
  it("maps microphone denial", async () => {
    const denied = new DOMException("denied", "NotAllowedError");
    const { phone } = harness({ mediaDevices: { getUserMedia: vi.fn(async () => { throw denied; }) } });
    await phone.initialize(); await phone.requestProvisioningSession(request);
    await expect(phone.connect()).rejects.toMatchObject({ code: "MICROPHONE_DENIED" });
  });
  it("maps missing media devices", async () => {
    const { phone } = harness({ mediaDevices: { getUserMedia: vi.fn(async () => ({ getAudioTracks: () => [], getTracks: () => [] })) } });
    await phone.initialize(); await phone.requestProvisioningSession(request);
    await expect(phone.connect()).rejects.toMatchObject({ code: "NO_MEDIA_DEVICE" });
  });
  it("replaces the input device and stops the old track", async () => {
    const { phone, mediaDevices } = harness(); await phone.initialize(); await phone.requestProvisioningSession(request); await phone.connect();
    await phone.replaceInputDevice("mic-2"); expect(mediaDevices.getUserMedia).toHaveBeenLastCalledWith({ audio: { deviceId: { exact: "mic-2" } }, video: false });
  });
  it("rejects output replacement when setSinkId is unsupported", async () => {
    const { phone } = harness(); await phone.initialize(document.createElement("audio"));
    await expect(phone.replaceOutputDevice("speaker")).rejects.toMatchObject({ code: "UNSUPPORTED_BROWSER" });
  });
  it("disconnect cleanup stops media and transport", async () => {
    const { phone, ua } = harness(); await phone.initialize(); await phone.requestProvisioningSession(request); await phone.connect(); await phone.disconnect();
    expect(ua.stop).toHaveBeenCalled(); expect(phone.getSnapshot().media.localTrackState).toBe("missing");
  });
  it("logout destroy revokes and removes listeners", async () => {
    const { phone, deps } = harness(); await phone.initialize(); await phone.requestProvisioningSession(request); const listener = vi.fn(); phone.subscribe(listener);
    await phone.destroy(); expect(deps.revoke).toHaveBeenCalled(); expect(phone.getSnapshot().state).toBe("REVOKED");
  });
  it("unsupported browsers fail initialization", async () => {
    vi.stubGlobal("RTCPeerConnection", undefined); const { phone } = harness();
    await expect(phone.initialize()).rejects.toMatchObject({ code: "UNSUPPORTED_BROWSER" });
  });
  it("diagnostic fallback remains explicitly fail closed", async () => {
    const phone = new DiagnosticPhone(); expect(phone.mode).toBe("DIAGNOSTIC_FAIL_CLOSED");
    await expect(phone.connect()).rejects.toMatchObject({ code: "UNSUPPORTED_BROWSER" });
  });
  it("does not leak credentials through snapshots or errors", async () => {
    const { phone } = harness(); await phone.initialize(); await phone.requestProvisioningSession(request);
    expect(JSON.stringify(phone.getSnapshot())).not.toMatch(/memory-only-credential|temporary-turn-credential/);
  });
});
