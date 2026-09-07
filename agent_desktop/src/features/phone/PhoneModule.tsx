import { Badge } from "../../components/Badge";
import { Card } from "../../components/Card";
import type { AudioDevice } from "../../devices";
import type { PhoneMode, PhoneState } from "../../phone";
import type { CallState, RegistrationState } from "../../types";

interface Props {
  mode: PhoneMode; state: PhoneState; registration: RegistrationState; call: CallState; duplicate: boolean; muted: boolean;
  inputs: AudioDevice[]; outputs: AudioDevice[]; input: string; output: string; message: string;
  onInput: (value: string) => void; onOutput: (value: string) => void; onPrepare: () => void; onRegister: () => void; registerEnabled: boolean; onDisconnect: () => void;
  onDial: () => void; onAnswer: () => void; onReject: () => void; onMute: () => void; onHold: () => void;
  onHangup: () => void; onReconnect: () => void; onMicTest: () => void; onSpeakerTest: () => void;
}

const busyStates: PhoneState[] = ["PROVISIONING", "CONNECTING", "REGISTERING", "DIALING", "DISCONNECTING", "RECONNECTING"];

export function PhoneModule(props: Props) {
  const busy = busyStates.includes(props.state);
  const capable = props.mode === "SIPJS_STAGING";
  const registered = props.state === "REGISTERED";
  const inCall = ["INCOMING", "RINGING", "ACTIVE", "HELD", "DIALING"].includes(props.state);
  return <Card title="Phone" className="phone-module" action={<Badge tone={registered ? "good" : "warn"}>{props.mode}</Badge>}>
    <div className="inline-alert">TEST_SYN ONLY · endpoint 6101 · extension 6000 echo · transfers and external routes disabled</div>
    {!capable && <div className="inline-alert">Diagnostic fail-closed mode: SIP/WebRTC operations are unavailable.</div>}
    {props.duplicate && <div className="inline-alert">Duplicate tab detected. Registration blocked.</div>}
    <div className="call-display"><div className="pulse"/><span><small>Phone state</small><strong>{props.state}</strong></span><b>{props.call}</b></div>
    <div className="row">
      <button onClick={props.onPrepare} disabled={!capable || props.duplicate || busy || registered || inCall || props.state === "PROVISIONED"}>Prepare M11 (no REGISTER)</button>
      <button data-testid="provision-register" onClick={props.onRegister} disabled={!props.registerEnabled || props.duplicate || busy || registered || inCall}>Provision + register</button>
      <button onClick={props.onDial} disabled={!capable || busy || !registered}>Call echo 6000</button>
      <button onClick={props.onDisconnect} disabled={!capable || busy || props.state === "DISCONNECTED"}>Disconnect</button>
      <button onClick={props.onAnswer} disabled={!capable || busy || props.state !== "INCOMING"}>Answer</button>
      <button onClick={props.onReject} disabled={!capable || busy || props.state !== "INCOMING"}>Reject</button>
      <button onClick={props.onMute} disabled={!capable || busy || !["ACTIVE", "HELD"].includes(props.state)}>{props.muted ? "Unmute" : "Mute"}</button>
      <button onClick={props.onHold} disabled={!capable || busy || !["ACTIVE", "HELD"].includes(props.state)}>{props.state === "HELD" ? "Resume" : "Hold"}</button>
      <button className="danger" onClick={props.onHangup} disabled={!capable || busy || !inCall}>Hang up</button>
      <button onClick={props.onReconnect} disabled={!capable || busy || !["REGISTERED", "RECONNECTING", "ERROR"].includes(props.state)}>Refresh credentials</button>
    </div>
    <div className="device compact">
      <label>Microphone<select value={props.input} onChange={event => props.onInput(event.target.value)}>{props.inputs.map(device => <option value={device.deviceId} key={device.deviceId}>{device.label}</option>)}</select></label>
      <label>Speaker<select value={props.output} onChange={event => props.onOutput(event.target.value)} disabled={!props.outputs.length}>{props.outputs.map(device => <option value={device.deviceId} key={device.deviceId}>{device.label}</option>)}</select></label>
    </div>
    <div className="row"><button className="secondary" onClick={props.onMicTest}>Microphone test</button><button className="secondary" onClick={props.onSpeakerTest}>Speaker test</button></div>
    <p className="message">{props.message}</p>
  </Card>;
}
