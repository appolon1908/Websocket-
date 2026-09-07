import {useEffect,useMemo,useState} from "react";
import {useAutosaveNote} from "../../useAutosaveNote";
import {workspaceService,type Workspace} from "../../workspace";

const terminal=new Set(["completed","failed","missed","rejected","cancelled","transferred"]);
const elapsed=(start:string|null,end?:string|null)=>{
  if(!start)return "00:00";
  const seconds=Math.max(0,Math.floor(((end?Date.parse(end):Date.now())-Date.parse(start))/1000));
  return `${String(Math.floor(seconds/60)).padStart(2,"0")}:${String(seconds%60).padStart(2,"0")}`;
};

export function CallWorkspace({workspace,onRefresh}:{workspace:Workspace;onRefresh:()=>Promise<void>}){
  const ownNote=workspace.notes.find(note=>note.type==="agent");
  const note=useAutosaveNote(workspace.call_id,ownNote?.body??"",ownNote?.id);
  const [disposition,setDisposition]=useState(""),[subDisposition,setSubDisposition]=useState("");
  const [callbackAt,setCallbackAt]=useState(""),[callbackReason,setCallbackReason]=useState("");
  const [taskSummary,setTaskSummary]=useState(""),[taskDue,setTaskDue]=useState("");
  const [feedback,setFeedback]=useState(""),[,tick]=useState(0);
  useEffect(()=>{const timer=window.setInterval(()=>tick(value=>value+1),1000);return()=>window.clearInterval(timer);},[]);
  const selected=useMemo(()=>workspace.dispositions.find(item=>item.code===disposition),[workspace.dispositions,disposition]);
  const displayName=workspace.customer?.name??workspace.lead?.name??"Unmatched caller";
  const saveDisposition=async()=>{try{await workspaceService.disposition(workspace.call_id,disposition,subDisposition||undefined,note.body);setFeedback("Disposition saved");await onRefresh();}catch(error){setFeedback(error instanceof Error?error.message:"Disposition failed");}};
  const saveCallback=async()=>{try{await workspaceService.callback(workspace.call_id,new Date(callbackAt).toISOString(),Intl.DateTimeFormat().resolvedOptions().timeZone,callbackReason);setFeedback("Callback scheduled; automatic dialing remains disabled");await onRefresh();}catch(error){setFeedback(error instanceof Error?error.message:"Callback failed");}};
  const saveTask=async()=>{try{await workspaceService.followUp(workspace.call_id,taskSummary,taskDue,note.body);setTaskSummary("");setTaskDue("");setFeedback("Follow-up task created");}catch(error){setFeedback(error instanceof Error?error.message:"Follow-up task failed");}};
  return <section className={`call-workspace state-${workspace.state}`} aria-labelledby="active-call-heading">
    <header className="call-header">
      <div><span className="direction">{workspace.direction}</span><h2 id="active-call-heading">{displayName}</h2><p>{workspace.caller_number||"Number unavailable"} · {workspace.campaign} · Ext {workspace.extension}</p></div>
      <div className="call-clock" aria-live="polite"><strong>{workspace.state}</strong><span>Agent {workspace.agent_status??"offline"}</span><span>Total {elapsed(workspace.ringing_at,workspace.ended_at)}</span><span>Talk {elapsed(workspace.answered_at,workspace.ended_at)}</span>{terminal.has(workspace.state)&&<span>Wrap-up target {workspace.wrap_up_timeout_seconds??120}s</span>}</div>
    </header>
    <div className="call-workspace-grid">
      <aside className="workspace-column customer-360" aria-label="Customer 360">
        <h3>Customer 360</h3><dl><dt>Contact</dt><dd>{workspace.customer?.name??"No exact match"}</dd><dt>Company</dt><dd>{workspace.company?.name??"—"}</dd><dt>Lead / opportunity</dt><dd>{workspace.opportunity?.name??workspace.lead?.name??"—"}</dd><dt>Opportunity stage</dt><dd>{workspace.opportunity?.stage??"—"}</dd><dt>Email</dt><dd>{workspace.crm.email??"—"}</dd><dt>Phone</dt><dd>{workspace.crm.phone??workspace.caller_number}</dd><dt>Location</dt><dd>{[workspace.location?.city,workspace.location?.state,workspace.location?.country].filter(Boolean).join(", ")||"—"}</dd><dt>Match</dt><dd><span className="badge info">{workspace.match_status}</span></dd></dl>
        <div className="quick-actions"><h3>Quick actions</h3>{workspace.crm.contact_id&&<a href={`/web#id=${workspace.crm.contact_id}&model=res.partner&view_type=form`}>Open contact</a>}{workspace.crm.lead_id&&<a href={`/web#id=${workspace.crm.lead_id}&model=crm.lead&view_type=form`}>Open lead</a>}<button disabled title="External delivery is not authorized">Send SMS</button><button disabled title="External delivery is not authorized">Send email</button></div>
      </aside>
      <div className="workspace-column call-center">
        <h3>Call timeline</h3><ol className="timeline">{workspace.timeline.map(item=><li key={`${item.sequence}-${item.event}`}><time>{new Date(item.time).toLocaleTimeString()}</time><strong>{item.event}</strong><small>{item.source}{item.actor?` · ${item.actor}`:""} · #{item.sequence}</small></li>)}</ol>
        <label className="field"><span>Live notes</span><textarea aria-describedby="note-status" value={note.body} onChange={event=>note.setBody(event.target.value)} maxLength={10000}/></label>
        <div className="note-tools">{workspace.note_templates.map(template=><button className="secondary" key={template.id} onClick={()=>note.setBody(note.body?`${note.body}\n${template.body}`:template.body)}>{template.name}</button>)}</div><p id="note-status" role="status">Autosave: {note.state}</p>
        {terminal.has(workspace.state)&&<div className="wrap-up"><h3>Wrap-up</h3><label className="field"><span>Disposition</span><select value={disposition} onChange={event=>{setDisposition(event.target.value);setSubDisposition("");}}><option value="">Select outcome</option>{workspace.dispositions.map(item=><option key={item.code} value={item.code}>{item.name}</option>)}</select></label>{selected?.children.length?<label className="field"><span>Sub-disposition</span><select value={subDisposition} onChange={event=>setSubDisposition(event.target.value)}><option value="">Select detail</option>{selected.children.map(item=><option key={item.code} value={item.code}>{item.name}</option>)}</select></label>:null}<button disabled={!disposition||note.state==="saving"} onClick={()=>void saveDisposition()}>Complete wrap-up</button></div>}
      </div>
      <aside className="workspace-column interaction-history" aria-label="Interactions and follow-up"><h3>Previous interactions</h3>{workspace.previous_calls?.length?<ul>{workspace.previous_calls.map(item=><li key={item.call_id}><strong>{item.direction} · {item.disposition??"No disposition"}</strong><p>{item.notes??"No notes"}</p><small>{item.date?new Date(item.date).toLocaleString():"Date unavailable"} · {item.duration}s</small></li>)}</ul>:<p>No previous calls.</p>}<h3>Recent communications</h3>{workspace.recent_communications?.length?<ul>{workspace.recent_communications.map(item=><li key={item.id}>{item.channel} · {item.subject}<small>{new Date(item.date).toLocaleString()} · {item.status}</small></li>)}</ul>:<p>No authorized communication history.</p>}<h3>Open tasks</h3>{workspace.open_tasks?.length?<ul>{workspace.open_tasks.map(item=><li key={item.id}>{item.summary}<small>{item.owner} · due {item.due_date}</small></li>)}</ul>:<p>No open tasks.</p>}<h3>Schedule callback</h3><label className="field"><span>Date and time</span><input type="datetime-local" value={callbackAt} onChange={event=>setCallbackAt(event.target.value)}/></label><label className="field"><span>Reason</span><input value={callbackReason} onChange={event=>setCallbackReason(event.target.value)}/></label><button disabled={!callbackAt||!callbackReason} onClick={()=>void saveCallback()}>Schedule callback</button><h3>Callbacks</h3><ul>{workspace.callbacks.map(item=><li key={item.id}>{new Date(item.scheduled_at).toLocaleString()} · {item.status}<small>{item.reason}</small></li>)}</ul><h3>Create follow-up</h3><label className="field"><span>Task summary</span><input value={taskSummary} onChange={event=>setTaskSummary(event.target.value)} maxLength={256}/></label><label className="field"><span>Due date</span><input type="date" value={taskDue} onChange={event=>setTaskDue(event.target.value)}/></label><button disabled={!taskSummary||!taskDue} onClick={()=>void saveTask()}>Create task</button></aside>
    </div>{feedback&&<p className="workspace-feedback" role="status">{feedback}</p>}
  </section>;
}
