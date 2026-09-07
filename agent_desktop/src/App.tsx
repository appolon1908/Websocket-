import { useEffect, useMemo, useRef, useState } from "react";
import { browserSession, provision, refreshProvisioning, revokeProvisioning } from "./api";
import { callbackService } from "./callbacks";
import { features } from "./config/features";
import { runtime } from "./config/runtime";
import { audioDevices, microphonePermission, type AudioDevice } from "./devices";
import { emptySnapshot, sanitizedExport, type MediaSnapshot } from "./diagnostics";
import { AiModule } from "./features/ai/AiModule";
import { CallbackModule } from "./features/callbacks/CallbackModule";
import { CrmModule } from "./features/crm/CrmModule";
import { DiagnosticsModule } from "./features/diagnostics/DiagnosticsModule";
import { DispositionModule } from "./features/disposition/DispositionModule";
import { LeadDetailsModule } from "./features/lead/LeadDetailsModule";
import { NotificationsModule } from "./features/notifications/NotificationsModule";
import { PhoneModule } from "./features/phone/PhoneModule";
import { SettingsModule } from "./features/settings/SettingsModule";
import { SupervisorModule } from "./features/supervisor/SupervisorModule";
import { CallWorkspace } from "./features/workspace/CallWorkspace";
import { DiagnosticPhone, SipJsPhone, type PhoneAdapter, type PhoneSnapshot } from "./phone";
import { mockDesktopService } from "./services/desktop";
import type { DesktopData } from "./types/desktop";
import { useSingleTab } from "./useSingleTab";
import { RealtimeClient, type RealtimeEvent, type RealtimeEvidence, type RealtimeState } from "./realtime";
import { workspaceService, type Workspace } from "./workspace";
import "./styles.css";

type View = "workspace" | "supervisor" | "diagnostics" | "settings";
const browserSessionId = crypto.randomUUID();
const CERTIFICATION_USERNAME = "synthetic.agent.test.syn.6101";
const CERTIFICATION_SUBJECT = "46c6027f-1ea8-4010-a104-5b908aabb715";

const createPhone = (): PhoneAdapter => {
  if (runtime.environment === "staging" && runtime.sipEnabled && runtime.webRtcEnabled && !runtime.safeMode) {
    return new SipJsPhone({ provision, refresh: refreshProvisioning, revoke: revokeProvisioning });
  }
  return new DiagnosticPhone();
};

export default function App() {
  const phone = useMemo(createPhone, []);
  const duplicate = useSingleTab();
  const remoteAudio = useRef<HTMLAudioElement>(null);
  const [data, setData] = useState<DesktopData>();
  const [view, setView] = useState<View>("workspace");
  const [phoneSnapshot, setPhoneSnapshot] = useState<PhoneSnapshot>(phone.getSnapshot());
  const [inputs, setInputs] = useState<AudioDevice[]>([]);
  const [outputs, setOutputs] = useState<AudioDevice[]>([]);
  const [input, setInput] = useState("");
  const [output, setOutput] = useState("");
  const [message, setMessage] = useState("Staging-only · production routes and transfers disabled");
  const [realtimeState, setRealtimeState] = useState<RealtimeState>("Disconnected");
  const [screenPop, setScreenPop] = useState<RealtimeEvent>();
  const [activeWorkspace, setActiveWorkspace] = useState<Workspace>();
  const [workspaceError, setWorkspaceError] = useState("");
  const [recordingState, setRecordingState] = useState("Off");
  const [playbackUrl, setPlaybackUrl] = useState<string|null>(null);
  const [recordingError, setRecordingError] = useState<string|null>(null);
  const [browserLogin, setBrowserLogin] = useState(false);
  const [canonicalIdentity, setCanonicalIdentity] = useState(false);
  const [realtimeEvidence, setRealtimeEvidence] = useState<Set<RealtimeEvidence>>(new Set());
  const [webphoneSession, setWebphoneSession] = useState(false);
  const [wssReachable, setWssReachable] = useState(false);
  const [microphoneReady, setMicrophoneReady] = useState(false);
  const [speakerReady, setSpeakerReady] = useState(false);
  const realtime = useRef<RealtimeClient | undefined>(undefined);
  const workspaceSequence = useRef(0);

  const loadWorkspace = async (callId:string) => {
    try {
      const loaded=await workspaceService.load(callId);
      workspaceSequence.current=loaded.sequence;setActiveWorkspace(loaded);setWorkspaceError("");
    } catch(error) { setWorkspaceError(error instanceof Error?error.message:"Call workspace unavailable"); }
  };

  useEffect(() => {
    let cancelled = false;
    void browserSession().then(identity => {
      if (cancelled) return;
      setBrowserLogin(identity.authenticated);
      const exactIdentity = identity.username === CERTIFICATION_USERNAME && identity.subject === CERTIFICATION_SUBJECT;
      setCanonicalIdentity(exactIdentity);
      if (!exactIdentity) throw new Error("Certification identity mismatch");
      realtime.current = new RealtimeClient(event => {
        if (event.call_id&&event.type.startsWith("call.")&&event.sequence>=workspaceSequence.current) {
          if(event.type === "call.ringing")setScreenPop(event);
          void loadWorkspace(event.call_id);
        }
        if (event.type === "callback.due") setScreenPop(event);
        if (event.type === "recording.started") setRecordingState("ON");
        if (event.type === "recording.available") setRecordingState("Available");
        if (event.type === "session.revoked") realtime.current?.disconnect();
      }, setRealtimeState, evidence => setRealtimeEvidence(current => new Set(current).add(evidence)));
      return realtime.current.connect().then(async()=>{
        try {
          const current=await workspaceService.current();
          if(current?.call_id)await loadWorkspace(current.call_id);
        } catch(error) {
          setWorkspaceError(error instanceof Error?error.message:"Active call recovery unavailable");
        }
      });
    }).catch(error => { setRealtimeState("Disconnected"); setMessage(error instanceof Error ? error.message : "Authentication failed"); });
    return () => { cancelled = true; realtime.current?.disconnect(); };
  }, []);

  useEffect(()=>{
    if(!duplicate)return;
    realtime.current?.disconnect();setScreenPop(undefined);setActiveWorkspace(undefined);
    setMessage("Duplicate tab detected. Registration and call workspace delivery blocked.");
  },[duplicate]);

  useEffect(() => {
    void mockDesktopService.load().then(setData);
    const unsubscribe = phone.subscribe(setPhoneSnapshot);
    const refreshDevices = async () => {
      try {
        const permission = await microphonePermission();
        const devices = await audioDevices();
        setInputs(devices.inputs); setOutputs(devices.outputs);
        setPhoneSnapshot(current => ({ ...current, media: { ...current.media, microphonePermission: permission, hasMicrophone: devices.inputs.length > 0 } }));
      } catch { setInputs([]); setOutputs([]); }
    };
    void refreshDevices();
    navigator.mediaDevices?.addEventListener("devicechange", refreshDevices);
    return () => {
      navigator.mediaDevices?.removeEventListener("devicechange", refreshDevices);
      unsubscribe();
      void phone.destroy();
    };
  }, [phone]);

  useEffect(() => {
    if (!data || !remoteAudio.current) return;
    void phone.initialize(remoteAudio.current).catch(error =>
      setMessage(error instanceof Error ? error.message : "Phone initialization failed")
    );
  }, [data, phone]);

  if (!data) return <div className="loading">Loading staging desktop…</div>;

  const run = async (action: () => Promise<void>, success: string) => {
    try { await action(); setMessage(success); }
    catch (error) { setMessage(error instanceof Error ? error.message : "Phone operation failed"); }
  };
  const probeWss = () => new Promise<void>((resolve, reject) => {
    const socket = new WebSocket(runtime.wssUrl, "sip");
    const timer = window.setTimeout(() => { socket.close(); reject(new Error("Asterisk WSS probe timed out")); }, 7000);
    socket.onopen = () => { window.clearTimeout(timer); socket.close(1000, "M11 reachability only"); resolve(); };
    socket.onerror = () => { window.clearTimeout(timer); reject(new Error("Asterisk WSS is unreachable")); };
  });
  const prepare = () => run(async () => {
    if (duplicate) throw new Error("Duplicate browser session detected");
    if (!browserLogin || !canonicalIdentity) throw new Error("Canonical browser identity required");
    await phone.requestProvisioningSession({ campaignId: "TEST_SYN", endpoint: "6101", browserSessionId });
    setWebphoneSession(true);
    await probeWss(); setWssReachable(true);
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    setMicrophoneReady(stream.getAudioTracks().some(track => track.readyState === "live"));
    stream.getTracks().forEach(track => track.stop());
    const devices = await navigator.mediaDevices.enumerateDevices();
    setSpeakerReady(devices.some(device => device.kind === "audiooutput") || typeof AudioContext !== "undefined");
  }, "M11 readiness complete; SIP REGISTER has not been sent");
  const featureState = runtime.environment === "staging" && !runtime.safeMode && runtime.sipEnabled && runtime.webRtcEnabled && runtime.testSynOnly && !runtime.productionPstn;
  const diagnosticFailClosed = !(featureState && browserLogin && canonicalIdentity && realtimeState === "Connected" && webphoneSession && wssReachable && microphoneReady && speakerReady);
  const register = () => run(async () => {
    if (diagnosticFailClosed) throw new Error("M11 readiness gates are incomplete");
    if (phone.getSnapshot().state !== "PROVISIONED") await phone.requestProvisioningSession({ campaignId: "TEST_SYN", endpoint: "6101", browserSessionId });
    await phone.connect();
    await phone.register();
  }, "Short-lived staging registration complete");
  const micTest = async () => {
    let stream: MediaStream | undefined;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: input ? { deviceId: { exact: input } } : true });
      setMessage("Microphone permission and live track verified; no audio recorded");
    } catch { setMessage("Microphone test failed"); }
    finally { stream?.getTracks().forEach(track => track.stop()); }
  };
  const speakerTest = async () => {
    const context = new AudioContext(), oscillator = context.createOscillator(), gain = context.createGain();
    gain.gain.value = 0.05; oscillator.connect(gain).connect(context.destination); oscillator.start();
    window.setTimeout(() => { oscillator.stop(); void context.close(); }, 500);
  };
  const exportDiagnostics = () => {
    const body = new Blob([sanitizedExport({ timestamp: new Date().toISOString(), snapshot: phoneSnapshot, browser: navigator.userAgent })], { type: "application/json" });
    const anchor = document.createElement("a"); anchor.href = URL.createObjectURL(body); anchor.download = `codestra-diagnostics-${Date.now()}.json`; anchor.click(); URL.revokeObjectURL(anchor.href);
  };
  const callState = phoneSnapshot.state === "INCOMING" ? "Ringing" : phoneSnapshot.state === "ACTIVE" ? "Active" : phoneSnapshot.state === "HELD" ? "Held" : "Idle";
  const registration = phoneSnapshot.state === "REGISTERED" ? "Registered" : ["CONNECTING", "REGISTERING", "PROVISIONING", "RECONNECTING"].includes(phoneSnapshot.state) ? "Connecting" : phoneSnapshot.state === "ERROR" ? "Failed" : "Offline";

  return <div className="app-shell">
    <aside><div className="brand"><i>C</i><span>CODESTRA<small>Agent Desktop</small></span></div>
      <nav>{([["workspace", "Workspace"], ["supervisor", "Supervisor"], ["diagnostics", "Diagnostics"], ["settings", "Settings"]] as [View, string][]).map(([id, label]) => <button className={view === id ? "active" : ""} onClick={() => setView(id)} key={id}>{label}</button>)}</nav>
      <div className="agent"><span>MR</span><div><strong>Maya Rivera</strong><small>WEBSET01 · Setter</small></div></div>
    </aside>
    <main className="workspace"><header className="topbar"><div><small>TEST_SYN · ENDPOINT 6101 · INTERNAL ONLY</small><h1>{view[0].toUpperCase() + view.slice(1)}</h1></div>
      <div className="top-status"><span className="ready-dot"/>{phone.mode} <button onClick={() => setView("diagnostics")}>Phone: {registration}</button><button data-testid="realtime-status">Realtime: {realtimeState}</button><button className="bell" onClick={() => setView("workspace")}>{data.notifications.filter(item => !item.read).length}</button></div></header>
      <audio ref={remoteAudio} autoPlay playsInline aria-label="Remote call audio"/>
      {view === "workspace" && <div className="dashboard-grid">
        <section className="panel" data-testid="m11-state"
          data-environment={runtime.environment} data-safe-mode={String(runtime.safeMode)} data-sip-enabled={String(runtime.sipEnabled)}
          data-webrtc-enabled={String(runtime.webRtcEnabled)} data-test-syn-only={String(runtime.testSynOnly)} data-production-pstn={String(runtime.productionPstn)}
          data-browser-login={String(browserLogin)} data-canonical-identity={String(canonicalIdentity)} data-realtime-ticket-requested={String(realtimeEvidence.has("ticket-requested"))}
          data-realtime-ticket-issued={String(realtimeEvidence.has("ticket-issued"))} data-realtime-ticket-consumed={String(realtimeEvidence.has("ticket-consumed"))}
          data-application-websocket={realtimeState} data-webphone-session={String(webphoneSession)} data-wss-reachable={String(wssReachable)}
          data-microphone-ready={String(microphoneReady)} data-speaker-ready={String(speakerReady)} data-diagnostic-fail-closed={String(diagnosticFailClosed)}>
          <h2>M11 certification</h2><strong>{diagnosticFailClosed ? "Fail-closed" : "Ready — stop before REGISTER"}</strong>
        </section>
        {screenPop && <section className="panel" data-testid="screen-pop"><h2>Incoming call</h2><strong>{String(screenPop.payload.customer_name ?? "Customer")}</strong><p>{screenPop.campaign_id} · {String(screenPop.payload.phone ?? "")}</p><a href={`/web#id=${encodeURIComponent(String(screenPop.payload.lead_id ?? ""))}&model=crm.lead&view_type=form`}>Open lead</a></section>}
        {workspaceError&&<div className="workspace-error" role="alert">{workspaceError}<button onClick={()=>activeWorkspace&&void loadWorkspace(activeWorkspace.call_id)}>Retry</button></div>}
        {activeWorkspace&&<CallWorkspace workspace={activeWorkspace} onRefresh={()=>loadWorkspace(activeWorkspace.call_id)}/>}
        <section className="panel" data-testid="recording-state"><h2>Recording</h2><strong>{recordingState}</strong>{recordingState === "Available" && <button onClick={()=>{if(!activeWorkspace)return;setRecordingError(null);void workspaceService.playback(activeWorkspace.call_id).then(result=>setPlaybackUrl(result.playback_url)).catch(()=>setRecordingError("Recording is unavailable or you do not have permission."));}}>Play</button>}{playbackUrl&&<audio controls src={playbackUrl} onEnded={()=>setPlaybackUrl(null)}>Your browser cannot play this recording.</audio>}{recordingError&&<p role="alert">{recordingError}</p>}</section>
        {features.phone && <PhoneModule mode={phone.mode} state={phoneSnapshot.state} registration={registration} call={callState} duplicate={duplicate} muted={phoneSnapshot.muted} inputs={inputs} outputs={outputs} input={input} output={output} message={message}
          onInput={value => { setInput(value); void run(() => phone.replaceInputDevice(value), "Microphone changed"); }}
          onOutput={value => { setOutput(value); void run(() => phone.replaceOutputDevice(value), "Speaker changed"); }}
          onPrepare={() => void prepare()} onRegister={() => void register()} registerEnabled={!diagnosticFailClosed} onDisconnect={() => void run(() => phone.disconnect(), "Cleanup complete")}
          onDial={() => void run(() => phone.dial("6000"), "Echo-only call requested")}
          onAnswer={() => void run(() => phone.answer(), "Call answered")} onReject={() => void run(() => phone.reject(), "Call rejected")}
          onMute={() => void run(() => phoneSnapshot.muted ? phone.unmute() : phone.mute(), phoneSnapshot.muted ? "Unmuted" : "Muted")}
          onHold={() => void run(() => phoneSnapshot.held ? phone.resume() : phone.hold(), phoneSnapshot.held ? "Resumed" : "Held")}
          onHangup={() => void run(() => phone.hangup(), "Call ended and media cleaned")}
          onReconnect={() => void run(() => phone.refreshCredentials(), "Credentials refreshed and session recovered")}
          onMicTest={() => void micTest()} onSpeakerTest={() => void speakerTest()}/>}
        <CrmModule lead={data.lead} history={data.history}/><LeadDetailsModule lead={data.lead} onSave={notes => mockDesktopService.saveNotes(data.lead.id, notes)}/>
        <AiModule ai={data.ai}/><DispositionModule onSave={value => mockDesktopService.disposition(data.lead.id, value)}/>
        <CallbackModule onSave={(when, reason, timezone, priority) => mockDesktopService.scheduleCallback(data.lead.id, when, reason, timezone, priority)} onCallNow={callback => callbackService.start(callback.id, callback.version)} onSnooze={(callback, minutes) => callbackService.snooze(callback.id, callback.version, minutes)} due={screenPop?.type==="callback.due"?(() => {const context=(screenPop.payload.customer_context??{}) as Record<string,unknown>;return {id:String(screenPop.payload.callback_id),customer:String(context.customer_name??"Customer"),phoneMasked:String(screenPop.payload.phone_masked??"••• ••• ••••"),campaign:screenPop.campaign_id,reason:String(screenPop.payload.reason??"Callback"),scheduledAt:String(screenPop.payload.scheduled_at??screenPop.timestamp),customerTimezone:String(screenPop.payload.customer_timezone??"UTC"),lastCall:String(context.last_call??""),lastDisposition:String(context.last_disposition??""),lastNotes:String(context.last_notes??""),company:String(context.company??""),lead:String(context.lead??""),previousCallbacks:Number(context.previous_callbacks??0),openTasks:Number(context.open_tasks??0),recentCommunications:Array.isArray(context.recent_communications)?context.recent_communications.map(String):[],crmUrl:typeof context.crm_url==="string"?context.crm_url:undefined,version:Number(screenPop.payload.callback_version??1)};})():undefined}/><NotificationsModule items={data.notifications}/>
      </div>}
      {view === "supervisor" && <SupervisorModule/>}
      {view === "diagnostics" && <DiagnosticsModule snapshot={phoneSnapshot.media ?? emptySnapshot} onExport={exportDiagnostics}/>}
      {view === "settings" && <SettingsModule/>}
    </main>
  </div>;
}
