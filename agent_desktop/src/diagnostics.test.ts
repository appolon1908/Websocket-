import { describe, expect, it } from "vitest";
import { classifyMedia, emptySnapshot, sanitizedExport } from "./diagnostics";

const live = { ...emptySnapshot, microphonePermission: "granted" as const, hasMicrophone: true, localTrackState: "live" as const, localTrackEnabled: true, wssConnected: true, sipRegistered: true, iceState: "connected" as const, dtlsState: "connected" as const, packetsSent: 10, packetsReceived: 10, remoteTrackLive: true };

describe("diagnostic state machine", () => {
  it("reports permission denial", () => expect(classifyMedia({ ...live, microphonePermission: "denied" })).toBe("MIC_PERMISSION_DENIED"));
  it("reports missing microphone", () => expect(classifyMedia({ ...live, hasMicrophone: false })).toBe("MIC_DEVICE_MISSING"));
  it("reports muted and ended tracks", () => { expect(classifyMedia({ ...live, localTrackEnabled: false })).toBe("LOCAL_TRACK_NOT_LIVE"); expect(classifyMedia({ ...live, localTrackState: "ended" })).toBe("LOCAL_TRACK_NOT_LIVE"); });
  it("reports WSS and SIP failures", () => { expect(classifyMedia({ ...live, wssConnected: false })).toBe("WSS_DISCONNECTED"); expect(classifyMedia({ ...live, sipRegistered: false })).toBe("SIP_REGISTRATION_FAILED"); });
  it("reports ICE and DTLS failures", () => { expect(classifyMedia({ ...live, iceState: "failed" })).toBe("ICE_FAILED"); expect(classifyMedia({ ...live, dtlsState: "failed" })).toBe("DTLS_FAILED"); });
  it("reports missing RTP", () => { expect(classifyMedia({ ...live, packetsSent: 0 })).toBe("NO_OUTBOUND_RTP"); expect(classifyMedia({ ...live, packetsReceived: 0 })).toBe("NO_INBOUND_RTP"); });
  it("reports connected media", () => expect(classifyMedia(live)).toBe("MEDIA_CONNECTED"));
  it("redacts credentials", () => { const text = sanitizedExport({ token: "raw", nested: { password: "raw", ok: 1 } }); expect(text).not.toContain('"raw"'); expect(text).toContain("[REDACTED]"); });
});
