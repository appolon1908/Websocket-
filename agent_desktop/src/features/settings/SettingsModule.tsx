import {Card} from "../../components/Card";
import {features} from "../../config/features";
import {runtime} from "../../config/runtime";

export function SettingsModule(){return <Card title="Settings">
  <div className="inline-alert">Preview Mode · mock data only · live integrations disabled</div>
  <div className="settings"><label>Theme<select defaultValue="dark"><option value="dark">Midnight</option><option value="light">Light (preview)</option></select></label><label>Language<select defaultValue="en"><option value="en">English</option><option value="es">Español</option></select></label><label className="toggle"><input type="checkbox" defaultChecked/> Desktop notifications</label></div>
  <h3>Runtime safety</h3><div className="flags"><span><i className={runtime.safeMode?"on":"off"}/>safeMode: {String(runtime.safeMode)}</span><span><i className={runtime.mockMode?"on":"off"}/>mockMode: {String(runtime.mockMode)}</span><span><i className={runtime.liveIntegrationsDisabled?"on":"off"}/>liveIntegrationsDisabled: {String(runtime.liveIntegrationsDisabled)}</span></div>
  <h3>Integration flags</h3><div className="flags">{Object.entries(features).filter(([k])=>k.startsWith("live")||k==="controlledTransfers").map(([k,v])=><span key={k}><i className={v?"on":"off"}/>{k}: {String(v)}</span>)}</div>
</Card>}
