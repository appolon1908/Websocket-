import {
  Invitation,
  Inviter,
  Registerer,
  RegistererState,
  SessionState,
  UserAgent,
  Web,
} from "sip.js";
import { emptySnapshot, type MediaSnapshot } from "./diagnostics";
import type { ProvisioningSession } from "./types";

export const phoneStates = [
  "UNINITIALIZED", "PROVISIONING", "PROVISIONED", "CONNECTING", "CONNECTED", "REGISTERING",
  "REGISTERED", "INCOMING", "DIALING", "RINGING", "ACTIVE", "HELD",
  "RECONNECTING", "DISCONNECTING", "DISCONNECTED", "EXPIRED", "REVOKED", "ERROR",
] as const;
export type PhoneState = typeof phoneStates[number];
export type PhoneMode = "SIPJS_STAGING" | "DIAGNOSTIC_FAIL_CLOSED" | "DISABLED";

export const phoneErrorCodes = [
  "MICROPHONE_DENIED", "NO_MEDIA_DEVICE", "WSS_FAILURE", "SIP_AUTHENTICATION_FAILURE",
  "REGISTRATION_TIMEOUT", "TURN_FAILURE", "ICE_FAILURE", "DTLS_FAILURE", "MEDIA_TIMEOUT",
  "CREDENTIAL_EXPIRATION", "REVOKED_SESSION", "DUPLICATE_REGISTRATION",
  "NETWORK_INTERRUPTION", "UNAUTHORIZED_CAMPAIGN", "UNAUTHORIZED_USER",
  "UNAUTHORIZED_ROLE", "CALL_ROUTE_REJECTION", "TRANSFER_PROHIBITION",
  "UNSUPPORTED_BROWSER", "INVALID_STATE", "PROVISIONING_FAILURE",
] as const;
export type PhoneErrorCode = typeof phoneErrorCodes[number];

export class PhoneError extends Error {
  constructor(public readonly code: PhoneErrorCode, message: string, public readonly retryable = false) {
    super(message);
    this.name = "PhoneError";
  }
}

export interface PhoneSnapshot {
  mode: PhoneMode;
  state: PhoneState;
  muted: boolean;
  held: boolean;
  expiresAt?: string;
  error?: { code: PhoneErrorCode; message: string; retryable: boolean };
  media: MediaSnapshot;
}

export interface ProvisioningRequest {
  campaignId: string;
  endpoint: "6101";
  browserSessionId: string;
  signal?: AbortSignal;
}

export interface PhoneAdapter {
  readonly mode: PhoneMode;
  initialize(remoteAudio?: HTMLAudioElement): Promise<void>;
  requestProvisioningSession(request: ProvisioningRequest): Promise<ProvisioningSession>;
  connect(session?: ProvisioningSession): Promise<void>;
  disconnect(): Promise<void>;
  register(): Promise<void>;
  unregister(): Promise<void>;
  dial(target: string): Promise<void>;
  answer(): Promise<void>;
  reject(): Promise<void>;
  hangup(): Promise<void>;
  hold(): Promise<void>;
  resume(): Promise<void>;
  mute(): Promise<void>;
  unmute(): Promise<void>;
  sendDTMF(tone: string): Promise<void>;
  replaceInputDevice(deviceId: string): Promise<void>;
  replaceOutputDevice(deviceId: string): Promise<void>;
  refreshCredentials(): Promise<void>;
  revokeSession(): Promise<void>;
  destroy(): Promise<void>;
  getSnapshot(): PhoneSnapshot;
  subscribe(listener: (snapshot: PhoneSnapshot) => void): () => void;
}

type SipSession = Invitation | Inviter;
type Timer = ReturnType<typeof window.setTimeout>;
type UserAgentFactory = (options: ConstructorParameters<typeof UserAgent>[0]) => UserAgent;
type RegistererFactory = (ua: UserAgent) => Registerer;
type InviterFactory = (ua: UserAgent, uri: ReturnType<typeof UserAgent.makeURI>, options: ConstructorParameters<typeof Inviter>[2]) => Inviter;

export interface SipJsPhoneDependencies {
  provision: (request: ProvisioningRequest) => Promise<ProvisioningSession>;
  refresh: (sessionId: string, browserSessionBinding: string) => Promise<ProvisioningSession>;
  revoke: (sessionId: string, browserSessionBinding: string) => Promise<void>;
  userAgentFactory?: UserAgentFactory;
  registererFactory?: RegistererFactory;
  inviterFactory?: InviterFactory;
  mediaDevices?: MediaDevices;
  now?: () => number;
}

const waitFor = <T>(subscribe: (resolve: (value: T) => void, reject: (error: unknown) => void) => () => void, timeoutMs: number, code: PhoneErrorCode) =>
  new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => { cleanup(); reject(new PhoneError(code, "Operation timed out", true)); }, timeoutMs);
    const cleanup = subscribe(value => { window.clearTimeout(timer); resolve(value); }, error => { window.clearTimeout(timer); reject(error); });
  });

export class SipJsPhone implements PhoneAdapter {
  readonly mode = "SIPJS_STAGING" as const;
  private snapshot: PhoneSnapshot = { mode: this.mode, state: "UNINITIALIZED", muted: false, held: false, media: { ...emptySnapshot } };
  private listeners = new Set<(snapshot: PhoneSnapshot) => void>();
  private session?: ProvisioningSession;
  private ua?: UserAgent;
  private registerer?: Registerer;
  private activeSession?: SipSession;
  private incoming?: Invitation;
  private localStream?: MediaStream;
  private remoteStream?: MediaStream;
  private remoteAudio?: HTMLAudioElement;
  private expiryTimer?: Timer;
  private refreshTimer?: Timer;
  private reconnectTimer?: Timer;
  private metricsTimer?: Timer;
  private operation?: string;
  private destroyed = false;
  private unload = () => { void this.destroy(); };
  private online = () => { if (this.ua && !this.destroyed) void this.reconnect(); };
  private offline = () => this.fail("NETWORK_INTERRUPTION", "Network interrupted", true, "RECONNECTING");

  constructor(private readonly deps: SipJsPhoneDependencies) {}

  async initialize(remoteAudio?: HTMLAudioElement): Promise<void> {
    if (this.snapshot.state !== "UNINITIALIZED") return;
    if (!globalThis.RTCPeerConnection || !(this.deps.mediaDevices ?? navigator.mediaDevices)?.getUserMedia) throw this.fail("UNSUPPORTED_BROWSER", "WebRTC is unavailable");
    this.remoteAudio = remoteAudio;
    window.addEventListener("beforeunload", this.unload);
    window.addEventListener("online", this.online);
    window.addEventListener("offline", this.offline);
    this.setState("DISCONNECTED");
  }

  async requestProvisioningSession(request: ProvisioningRequest): Promise<ProvisioningSession> {
    this.ensureNotDestroyed();
    if (request.endpoint !== "6101" || request.campaignId !== "TEST_SYN") throw this.fail("UNAUTHORIZED_CAMPAIGN", "Only the approved synthetic campaign and endpoint are allowed");
    this.setState("PROVISIONING");
    try {
      const session = await this.deps.provision(request);
      this.validateProvisioning(session);
      this.session = session;
      this.scheduleCredentialLifecycle();
      this.setState("PROVISIONED");
      return session;
    } catch (error) {
      throw this.mapError(error, "PROVISIONING_FAILURE");
    }
  }

  async connect(session = this.session): Promise<void> {
    return this.exclusive("connect", async () => {
      this.ensureNotDestroyed();
      if (!session) throw this.fail("PROVISIONING_FAILURE", "Provisioning is required");
      this.validateProvisioning(session);
      if (this.ua) throw this.fail("DUPLICATE_REGISTRATION", "A browser SIP session already exists");
      await this.acquireMicrophone();
      this.setState("CONNECTING");
      const uri = UserAgent.makeURI(session.sip_uri);
      if (!uri) throw this.fail("PROVISIONING_FAILURE", "Provisioning returned an invalid SIP URI");
      const factory = this.deps.userAgentFactory ?? (options => new UserAgent(options));
      this.ua = factory({
        uri,
        authorizationUsername: session.authorization_username,
        authorizationPassword: session.ephemeral_password,
        transportOptions: { server: session.websocket_url, connectionTimeout: 10 },
        sessionDescriptionHandlerFactory: Web.defaultSessionDescriptionHandlerFactory(async constraints => {
          const stream = await (this.deps.mediaDevices ?? navigator.mediaDevices).getUserMedia(constraints);
          this.localStream?.getTracks().forEach(track => track.stop());
          this.localStream = stream;
          return stream;
        }),
        sessionDescriptionHandlerFactoryOptions: {
          peerConnectionConfiguration: { iceServers: session.ice_servers, iceCandidatePoolSize: 1 },
        },
        delegate: { onInvite: invitation => this.handleIncoming(invitation) },
        logBuiltinEnabled: false,
        logLevel: "error",
      });
      this.ua.transport.stateChange.addListener(state => {
        const connected = String(state) === "Connected";
        this.emitMedia({ wssConnected: connected });
        if (!connected && ["REGISTERED", "ACTIVE", "HELD"].includes(this.snapshot.state)) this.fail("WSS_FAILURE", "Secure signaling disconnected", true, "RECONNECTING");
      });
      try {
        await this.ua.start();
        this.setState("CONNECTED");
      } catch (error) {
        await this.cleanupTransport();
        throw this.mapError(error, "WSS_FAILURE");
      }
    });
  }

  async register(): Promise<void> {
    return this.exclusive("register", async () => {
      if (!this.ua) throw this.fail("INVALID_STATE", "Connect before registration");
      if (this.registerer && this.snapshot.state === "REGISTERED") throw this.fail("DUPLICATE_REGISTRATION", "Already registered");
      this.setState("REGISTERING");
      this.registerer = (this.deps.registererFactory ?? (ua => new Registerer(ua)))(this.ua);
      const done = waitFor<void>((resolve, reject) => {
        const listener = (state: RegistererState) => {
          if (state === RegistererState.Registered) { this.emitMedia({ sipRegistered: true }); this.setState("REGISTERED"); resolve(); }
          if (state === RegistererState.Terminated) reject(this.fail("SIP_AUTHENTICATION_FAILURE", "SIP registration rejected"));
        };
        this.registerer!.stateChange.addListener(listener);
        void this.registerer!.register().catch(reject);
        return () => this.registerer?.stateChange.removeListener(listener);
      }, 12_000, "REGISTRATION_TIMEOUT");
      await done;
    });
  }

  async disconnect(): Promise<void> {
    if (this.snapshot.state === "DISCONNECTED" || this.snapshot.state === "UNINITIALIZED") return;
    this.setState("DISCONNECTING");
    await this.hangup().catch(() => undefined);
    await this.unregister().catch(() => undefined);
    await this.cleanupTransport();
    this.stopMedia();
    this.setState("DISCONNECTED");
  }

  async unregister(): Promise<void> {
    if (this.registerer) await this.registerer.unregister().catch(() => undefined);
    this.registerer = undefined;
    this.emitMedia({ sipRegistered: false });
  }

  async dial(target: string): Promise<void> {
    return this.exclusive("dial", async () => {
      if (!this.ua || this.snapshot.state !== "REGISTERED") throw this.fail("INVALID_STATE", "Registration is required");
      if (target !== "6000" || !this.session?.permitted_call_scope.includes(target)) throw this.fail("CALL_ROUTE_REJECTION", "Only staging echo extension 6000 is permitted");
      const uri = UserAgent.makeURI(`sip:${target}@${new URL(this.session.websocket_url).hostname}`);
      if (!uri) throw this.fail("CALL_ROUTE_REJECTION", "Invalid staging route");
      this.setState("DIALING");
      this.activeSession = (this.deps.inviterFactory ?? ((ua, targetUri, options) => new Inviter(ua, targetUri!, options)))(this.ua, uri, {
        sessionDescriptionHandlerOptions: { constraints: { audio: this.audioConstraints(), video: false } },
      });
      this.watchSession(this.activeSession);
      try { await this.activeSession.invite(); this.setState("RINGING"); }
      catch (error) { await this.endSession(); throw this.mapError(error, "CALL_ROUTE_REJECTION"); }
    });
  }

  async answer(): Promise<void> {
    return this.exclusive("answer", async () => {
      if (!this.incoming) throw this.fail("INVALID_STATE", "No incoming call");
      this.activeSession = this.incoming; this.incoming = undefined;
      this.watchSession(this.activeSession);
      await (this.activeSession as Invitation).accept({ sessionDescriptionHandlerOptions: { constraints: { audio: this.audioConstraints(), video: false } } });
    });
  }

  async reject(): Promise<void> {
    if (!this.incoming) throw this.fail("INVALID_STATE", "No incoming call");
    await this.incoming.reject(); this.incoming = undefined; this.setState("REGISTERED");
  }

  async hangup(): Promise<void> {
    if (this.incoming) { await this.incoming.reject().catch(() => undefined); this.incoming = undefined; }
    await this.endSession();
  }

  async hold(): Promise<void> { await this.setHold(true); }
  async resume(): Promise<void> { await this.setHold(false); }

  async mute(): Promise<void> { this.setMuted(true); }
  async unmute(): Promise<void> { this.setMuted(false); }

  async sendDTMF(tone: string): Promise<void> {
    if (!/^[0-9A-D#*]$/i.test(tone) || this.snapshot.state !== "ACTIVE") throw this.fail("INVALID_STATE", "DTMF is unavailable");
    const handler = this.activeSession?.sessionDescriptionHandler as Web.SessionDescriptionHandler | undefined;
    if (!handler?.sendDtmf(tone)) throw this.fail("INVALID_STATE", "DTMF transport rejected");
  }

  async replaceInputDevice(deviceId: string): Promise<void> {
    const replacement = await this.getUserMedia(deviceId);
    const track = replacement.getAudioTracks()[0];
    const pc = this.peerConnection();
    const sender = pc?.getSenders().find(item => item.track?.kind === "audio");
    if (sender) await sender.replaceTrack(track);
    this.localStream?.getTracks().forEach(item => item.stop());
    this.localStream = replacement;
    this.emitMedia({ localTrackState: track.readyState, localTrackEnabled: track.enabled, hasMicrophone: true });
  }

  async replaceOutputDevice(deviceId: string): Promise<void> {
    const audio = this.remoteAudio as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> };
    if (!audio?.setSinkId) throw this.fail("UNSUPPORTED_BROWSER", "Output device selection is unsupported");
    await audio.setSinkId(deviceId);
  }

  async refreshCredentials(): Promise<void> {
    if (!this.session) throw this.fail("INVALID_STATE", "No provisioning session");
    const replacement = await this.deps.refresh(this.session.session_id, this.session.binding_id);
    this.validateProvisioning(replacement);
    const wasRegistered = this.snapshot.state === "REGISTERED";
    await this.disconnect();
    this.session = replacement;
    this.scheduleCredentialLifecycle();
    await this.connect(replacement);
    if (wasRegistered) await this.register();
  }

  async revokeSession(): Promise<void> {
    const id = this.session?.session_id;
    if (id && this.session) await this.deps.revoke(id, this.session.binding_id).catch(() => undefined);
    await this.disconnect();
    this.clearCredentials();
    this.setState("REVOKED");
  }

  async destroy(): Promise<void> {
    if (this.destroyed) return;
    await this.revokeSession();
    this.destroyed = true;
    window.removeEventListener("beforeunload", this.unload);
    window.removeEventListener("online", this.online);
    window.removeEventListener("offline", this.offline);
    this.listeners.clear();
  }

  getSnapshot(): PhoneSnapshot { return structuredClone(this.snapshot); }
  subscribe(listener: (snapshot: PhoneSnapshot) => void): () => void {
    this.listeners.add(listener); listener(this.getSnapshot());
    return () => this.listeners.delete(listener);
  }

  private async reconnect(): Promise<void> {
    if (!this.session || this.destroyed) return;
    window.clearTimeout(this.reconnectTimer);
    this.setState("RECONNECTING");
    this.reconnectTimer = window.setTimeout(() => void this.refreshCredentials().catch(error => this.mapError(error, "WSS_FAILURE")), 500);
  }

  private handleIncoming(invitation: Invitation): void {
    if (this.activeSession || this.incoming) { void invitation.reject(); return; }
    this.incoming = invitation;
    invitation.stateChange.addListener(state => { if (state === SessionState.Terminated && this.incoming === invitation) { this.incoming = undefined; this.setState("REGISTERED"); } });
    this.setState("INCOMING");
  }

  private watchSession(session: SipSession): void {
    session.stateChange.addListener(state => {
      if (state === SessionState.Established) { this.setState("ACTIVE"); this.attachMedia(); }
      if (state === SessionState.Terminated) { void this.endSession(false); }
    });
  }

  private attachMedia(): void {
    const pc = this.peerConnection();
    if (!pc) { this.fail("MEDIA_TIMEOUT", "Peer connection is unavailable"); return; }
    this.remoteStream = new MediaStream();
    pc.getReceivers().filter(receiver => receiver.track?.kind === "audio").forEach(receiver => this.remoteStream!.addTrack(receiver.track));
    if (this.remoteAudio) {
      this.remoteAudio.srcObject = this.remoteStream;
      void this.remoteAudio.play().then(() => this.emitMedia({ remotePlaybackAllowed: true })).catch(() => this.emitMedia({ remotePlaybackAllowed: false }));
    }
    pc.addEventListener("iceconnectionstatechange", () => {
      this.emitMedia({ iceState: pc.iceConnectionState });
      if (pc.iceConnectionState === "failed") this.fail("ICE_FAILURE", "ICE connection failed", true);
    });
    pc.addEventListener("connectionstatechange", () => {
      if (pc.connectionState === "failed") this.fail("DTLS_FAILURE", "Secure media connection failed", true);
    });
    this.metricsTimer = window.setInterval(() => void this.collectMetrics(pc), 2000);
  }

  private async collectMetrics(pc: RTCPeerConnection): Promise<void> {
    const stats = await pc.getStats();
    const change: Partial<MediaSnapshot> = {};
    stats.forEach(report => {
      if (report.type === "outbound-rtp" && report.kind === "audio") { change.packetsSent = report.packetsSent ?? 0; change.bytesSent = report.bytesSent ?? 0; }
      if (report.type === "inbound-rtp" && report.kind === "audio") { change.packetsReceived = report.packetsReceived ?? 0; change.bytesReceived = report.bytesReceived ?? 0; change.packetsLost = report.packetsLost ?? 0; change.jitterMs = Math.round((report.jitter ?? 0) * 1000); }
      if (report.type === "candidate-pair" && report.state === "succeeded") change.rttMs = Math.round((report.currentRoundTripTime ?? 0) * 1000);
      if (report.type === "local-candidate" && report.candidateType) change.candidateType = report.candidateType;
      if (report.type === "codec" && report.mimeType) change.codec = String(report.mimeType).replace(/^audio\//, "");
    });
    this.emitMedia(change);
  }

  private async setHold(held: boolean): Promise<void> {
    if (!this.activeSession || !["ACTIVE", "HELD"].includes(this.snapshot.state)) throw this.fail("INVALID_STATE", "No established call");
    await this.activeSession.invite({
      sessionDescriptionHandlerModifiers: held ? [Web.holdModifier] : [],
    });
    this.snapshot.held = held; this.setState(held ? "HELD" : "ACTIVE");
  }

  private setMuted(muted: boolean): void {
    if (!this.localStream || !["ACTIVE", "HELD"].includes(this.snapshot.state)) throw this.fail("INVALID_STATE", "No active media");
    this.localStream.getAudioTracks().forEach(track => { track.enabled = !muted; });
    this.snapshot.muted = muted; this.emit();
  }

  private async endSession(signal = true): Promise<void> {
    const session = this.activeSession; this.activeSession = undefined;
    if (session && signal) {
      if (session.state === SessionState.Established) await session.bye().catch(() => undefined);
      else if (session instanceof Inviter) await session.cancel().catch(() => undefined);
      else await session.reject().catch(() => undefined);
    }
    window.clearInterval(this.metricsTimer);
    this.remoteStream?.getTracks().forEach(track => track.stop());
    this.remoteStream = undefined;
    if (this.remoteAudio) this.remoteAudio.srcObject = null;
    this.snapshot.muted = false; this.snapshot.held = false;
    this.emitMedia({ remoteTrackLive: false, callEnded: true });
    if (!["DISCONNECTING", "REVOKED", "EXPIRED"].includes(this.snapshot.state)) this.setState(this.registerer ? "REGISTERED" : "DISCONNECTED");
  }

  private async acquireMicrophone(): Promise<void> {
    this.localStream = await this.getUserMedia();
    const track = this.localStream.getAudioTracks()[0];
    this.emitMedia({ microphonePermission: "granted", hasMicrophone: true, localTrackState: track.readyState, localTrackEnabled: track.enabled });
  }

  private async getUserMedia(deviceId?: string): Promise<MediaStream> {
    const devices = this.deps.mediaDevices ?? navigator.mediaDevices;
    try {
      const stream = await devices.getUserMedia({ audio: deviceId ? { deviceId: { exact: deviceId } } : { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
      if (!stream.getAudioTracks().length) throw this.fail("NO_MEDIA_DEVICE", "No microphone track was returned");
      return stream;
    } catch (error) {
      if (error instanceof DOMException && ["NotAllowedError", "SecurityError"].includes(error.name)) throw this.fail("MICROPHONE_DENIED", "Microphone permission denied");
      if (error instanceof PhoneError) throw error;
      throw this.fail("NO_MEDIA_DEVICE", "Microphone is unavailable");
    }
  }

  private audioConstraints(): MediaTrackConstraints {
    const id = this.localStream?.getAudioTracks()[0]?.getSettings().deviceId;
    return id ? { deviceId: { exact: id }, echoCancellation: true, noiseSuppression: true } : { echoCancellation: true, noiseSuppression: true };
  }

  private peerConnection(): RTCPeerConnection | undefined {
    return (this.activeSession?.sessionDescriptionHandler as Web.SessionDescriptionHandler | undefined)?.peerConnection;
  }

  private scheduleCredentialLifecycle(): void {
    window.clearTimeout(this.expiryTimer); window.clearTimeout(this.refreshTimer);
    if (!this.session) return;
    const remaining = Date.parse(this.session.expires_at) - (this.deps.now?.() ?? Date.now());
    this.snapshot.expiresAt = this.session.expires_at;
    this.refreshTimer = window.setTimeout(() => void this.refreshCredentials().catch(error => this.mapError(error, "CREDENTIAL_EXPIRATION")), Math.max(1000, remaining - 60_000));
    this.expiryTimer = window.setTimeout(() => { void this.disconnect(); this.clearCredentials(); this.setState("EXPIRED"); }, Math.max(1000, remaining));
  }

  private validateProvisioning(value: ProvisioningSession): void {
    if (value.endpoint !== "6101" || value.campaign_id !== "TEST_SYN" || value.environment !== "STAGING") throw this.fail("UNAUTHORIZED_CAMPAIGN", "Provisioning scope was rejected");
    if (!value.websocket_url.startsWith("wss://") || !value.ice_servers.some(server => ([] as string[]).concat(server.urls as string | string[]).some(url => url.startsWith("turns:")))) throw this.fail("TURN_FAILURE", "Approved secure signaling and TURN are required");
    if (Date.parse(value.expires_at) <= (this.deps.now?.() ?? Date.now()) + 5000) throw this.fail("CREDENTIAL_EXPIRATION", "Provisioning credentials are expired");
  }

  private async cleanupTransport(): Promise<void> {
    if (this.ua) await this.ua.stop().catch(() => undefined);
    this.ua = undefined; this.registerer = undefined;
    this.emitMedia({ wssConnected: false, sipRegistered: false });
  }

  private stopMedia(): void {
    this.localStream?.getTracks().forEach(track => track.stop()); this.localStream = undefined;
    this.remoteStream?.getTracks().forEach(track => track.stop()); this.remoteStream = undefined;
    if (this.remoteAudio) this.remoteAudio.srcObject = null;
    this.emitMedia({ localTrackState: "missing", localTrackEnabled: false, remoteTrackLive: false, callEnded: true });
  }

  private clearCredentials(): void {
    this.session = undefined; this.snapshot.expiresAt = undefined;
    window.clearTimeout(this.expiryTimer); window.clearTimeout(this.refreshTimer); window.clearTimeout(this.reconnectTimer);
  }

  private setState(state: PhoneState): void { this.snapshot.state = state; if (state !== "ERROR") this.snapshot.error = undefined; this.emit(); }
  private emitMedia(change: Partial<MediaSnapshot>): void { this.snapshot.media = { ...this.snapshot.media, ...change }; this.emit(); }
  private emit(): void { const copy = this.getSnapshot(); this.listeners.forEach(listener => listener(copy)); }
  private ensureNotDestroyed(): void { if (this.destroyed) throw new PhoneError("REVOKED_SESSION", "Phone adapter was destroyed"); }
  private fail(code: PhoneErrorCode, message: string, retryable = false, state: PhoneState = "ERROR"): PhoneError {
    const error = new PhoneError(code, message, retryable); this.snapshot.error = { code, message, retryable }; this.snapshot.state = state; this.emit(); return error;
  }
  private mapError(error: unknown, fallback: PhoneErrorCode): PhoneError {
    if (error instanceof PhoneError) return error;
    return this.fail(fallback, error instanceof Error ? error.message : "Phone operation failed", true);
  }
  private async exclusive<T>(operation: string, action: () => Promise<T>): Promise<T> {
    if (this.operation) throw this.fail("DUPLICATE_REGISTRATION", `${this.operation} is already in progress`);
    this.operation = operation;
    try { return await action(); } finally { this.operation = undefined; }
  }
}

export class DiagnosticPhone implements PhoneAdapter {
  readonly mode = "DIAGNOSTIC_FAIL_CLOSED" as const;
  private snapshot: PhoneSnapshot = { mode: this.mode, state: "DISCONNECTED", muted: false, held: false, media: { ...emptySnapshot } };
  private listeners = new Set<(snapshot: PhoneSnapshot) => void>();
  private denied(): never { throw new PhoneError("UNSUPPORTED_BROWSER", "Diagnostic fail-closed mode cannot perform SIP/WebRTC operations"); }
  async initialize(): Promise<void> {}
  async requestProvisioningSession(): Promise<ProvisioningSession> { return this.denied(); }
  async connect(): Promise<void> { this.denied(); }
  async disconnect(): Promise<void> {}
  async register(): Promise<void> { this.denied(); }
  async unregister(): Promise<void> {}
  async dial(): Promise<void> { this.denied(); }
  async answer(): Promise<void> { this.denied(); }
  async reject(): Promise<void> { this.denied(); }
  async hangup(): Promise<void> { this.denied(); }
  async hold(): Promise<void> { this.denied(); }
  async resume(): Promise<void> { this.denied(); }
  async mute(): Promise<void> { this.denied(); }
  async unmute(): Promise<void> { this.denied(); }
  async sendDTMF(): Promise<void> { this.denied(); }
  async replaceInputDevice(): Promise<void> { this.denied(); }
  async replaceOutputDevice(): Promise<void> { this.denied(); }
  async refreshCredentials(): Promise<void> { this.denied(); }
  async revokeSession(): Promise<void> {}
  async destroy(): Promise<void> { this.listeners.clear(); }
  getSnapshot(): PhoneSnapshot { return structuredClone(this.snapshot); }
  subscribe(listener: (snapshot: PhoneSnapshot) => void): () => void { this.listeners.add(listener); listener(this.getSnapshot()); return () => this.listeners.delete(listener); }
}
