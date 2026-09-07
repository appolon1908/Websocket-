export const diagnosticStates = [
  "MIC_PERMISSION_DENIED", "MIC_DEVICE_MISSING", "LOCAL_TRACK_NOT_LIVE",
  "WSS_DISCONNECTED", "SIP_REGISTRATION_FAILED", "ICE_FAILED", "DTLS_FAILED",
  "NO_OUTBOUND_RTP", "NO_INBOUND_RTP", "REMOTE_AUDIO_BLOCKED",
  "MEDIA_CONNECTED", "CALL_ENDED", "UNKNOWN_MEDIA_FAILURE"
] as const;

export type DiagnosticState = typeof diagnosticStates[number];

export interface MediaSnapshot {
  microphonePermission: PermissionState | "unsupported";
  hasMicrophone: boolean;
  localTrackState: MediaStreamTrackState | "missing";
  localTrackEnabled: boolean;
  wssConnected: boolean;
  sipRegistered: boolean;
  iceState: RTCIceConnectionState | "unknown";
  iceGatheringState: RTCIceGatheringState | "unknown";
  dtlsState: RTCDtlsTransportState | "unknown";
  packetsSent: number;
  bytesSent: number;
  packetsReceived: number;
  bytesReceived: number;
  packetsLost: number;
  jitterMs: number;
  rttMs: number;
  codec: string;
  candidateType: string;
  remoteTrackLive: boolean;
  remotePlaybackAllowed: boolean;
  callEnded: boolean;
}

export function classifyMedia(s: MediaSnapshot): DiagnosticState {
  if (s.callEnded) return "CALL_ENDED";
  if (s.microphonePermission === "denied") return "MIC_PERMISSION_DENIED";
  if (!s.hasMicrophone) return "MIC_DEVICE_MISSING";
  if (s.localTrackState !== "live" || !s.localTrackEnabled) return "LOCAL_TRACK_NOT_LIVE";
  if (!s.wssConnected) return "WSS_DISCONNECTED";
  if (!s.sipRegistered) return "SIP_REGISTRATION_FAILED";
  if (s.iceState === "failed") return "ICE_FAILED";
  if (s.dtlsState === "failed" || s.dtlsState === "closed") return "DTLS_FAILED";
  if (s.packetsSent === 0) return "NO_OUTBOUND_RTP";
  if (s.packetsReceived === 0) return "NO_INBOUND_RTP";
  if (s.remoteTrackLive && !s.remotePlaybackAllowed) return "REMOTE_AUDIO_BLOCKED";
  if (s.remoteTrackLive && s.packetsSent > 0 && s.packetsReceived > 0) return "MEDIA_CONNECTED";
  return "UNKNOWN_MEDIA_FAILURE";
}

const redactedKeys = /password|credential|authorization|token|secret/i;
export function sanitizedExport(value: unknown): string {
  return JSON.stringify(value, (key, item) => redactedKeys.test(key) ? "[REDACTED]" : item, 2);
}

export const emptySnapshot: MediaSnapshot = {
  microphonePermission: "unsupported", hasMicrophone: false, localTrackState: "missing",
  localTrackEnabled: false, wssConnected: false, sipRegistered: false,
  iceState: "unknown", iceGatheringState: "unknown", dtlsState: "unknown",
  packetsSent: 0, bytesSent: 0, packetsReceived: 0, bytesReceived: 0,
  packetsLost: 0, jitterMs: 0, rttMs: 0, codec: "—", candidateType: "—",
  remoteTrackLive: false, remotePlaybackAllowed: true, callEnded: false
};
