export type CallState = "new"|"initiating"|"offered"|"ringing"|"answering"|"connected"|"held"|"transferring"|"transferred"|"ending"|"completed"|"failed"|"missed"|"rejected"|"cancelled";

export interface TimelineItem { event:string; time:string; source:string; actor:string|null; sequence:number; correlation_id:string; }
export interface CallNote { id:number; body:string; type:"agent"|"supervisor"|"wrap_up"; visibility:"agent"|"supervisor"; author:string; revision:number; updated_at:string; }
export interface SubDisposition { code:string; name:string; requires_callback:boolean; requires_task:boolean; }
export interface Disposition { code:string; name:string; requires_note:boolean; children:SubDisposition[]; }
export interface Callback { id:number; scheduled_at:string; timezone:string; reason:string; status:"scheduled"|"completed"|"cancelled"; owner:string; }
export interface Workspace {
  call_id:string; correlation_id:string; state:CallState; previous_state:CallState|null; sequence:number;
  direction:"inbound"|"outbound"; caller_number:string; campaign:string; business_unit:string;
  extension:string; ringing_at:string|null; answered_at:string|null; ended_at:string|null;
  customer:{id:number;name:string}|null; company:{id:number;name:string}|null;
  lead:{id:number;name:string}|null; opportunity:{id:number;name:string;stage?:string|null}|null;
  location?:{city:string|null;state:string|null;country:string|null}|null;
  crm:{lead_id:number|null;contact_id:number|null;email:string|null;phone:string|null};
  timeline:TimelineItem[]; notes:CallNote[]; dispositions:Disposition[]; callbacks:Callback[];
  note_templates:{id:number;name:string;body:string}[]; recording_status:string; recording_id?:string|null; match_status:string;
  agent_status?:string; wrap_up_timeout_seconds?:number;
  open_tasks?:{id:number;summary:string;due_date:string;owner:string;activity_type:string}[];
  recent_communications?:{id:number;date:string;channel:string;subject:string;status:string}[];
  previous_calls?:{call_id:string;date:string|null;direction:string;disposition:string|null;duration:number;notes:string|null}[];
  sms_status?:{available:boolean;reason:string};
}

interface RpcEnvelope<T> { jsonrpc:"2.0"; id:string; result?:T; error?:{message?:string;data?:{message?:string}}; }

export async function rpc<T>(route:string, params:Record<string,unknown> = {}, signal?:AbortSignal):Promise<T> {
  const id=crypto.randomUUID();
  const response=await fetch(route,{method:"POST",credentials:"include",signal,headers:{"Content-Type":"application/json","Accept":"application/json"},body:JSON.stringify({jsonrpc:"2.0",method:"call",params,id})});
  if(!response.ok) throw new Error(`Odoo workspace unavailable (${response.status})`);
  const envelope=await response.json() as RpcEnvelope<T>;
  if(envelope.error) throw new Error(envelope.error.data?.message||envelope.error.message||"Workspace request failed");
  return envelope.result as T;
}

export class WorkspaceService {
  load(callId:string,signal?:AbortSignal){return rpc<Workspace>(`/codestra/call-control/v1/calls/${encodeURIComponent(callId)}/workspace`,{},signal);}
  current(signal?:AbortSignal){return rpc<Workspace|null>("/codestra/call-control/v1/current",{},signal);}
  saveNote(callId:string,body:string,options:{noteId?:number;clientRevision:string;noteType?:string;visibility?:string}){
    return rpc<{saved:true;duplicate:boolean;note_id:number;revision:number}>(`/codestra/call-control/v1/calls/${encodeURIComponent(callId)}/notes`,{notes:body,idempotency_key:crypto.randomUUID(),note_id:options.noteId,client_revision:options.clientRevision,note_type:options.noteType||"agent",visibility:options.visibility||"agent"});
  }
  disposition(callId:string,code:string,subCode:string|undefined,notes:string){return rpc(`/codestra/call-control/v1/calls/${encodeURIComponent(callId)}/disposition`,{disposition_code:code,sub_disposition_code:subCode,notes,idempotency_key:crypto.randomUUID()});}
  callback(callId:string,scheduledAt:string,timezone:string,reason:string){return rpc(`/codestra/call-control/v1/calls/${encodeURIComponent(callId)}/callbacks`,{scheduled_at:scheduledAt,timezone,reason,idempotency_key:crypto.randomUUID()});}
  followUp(callId:string,summary:string,dueDate:string,note:string){return rpc<{activity_id:number;created:true}>(`/codestra/call-workspace/v1/calls/${encodeURIComponent(callId)}/tasks`,{summary,due_date:dueDate,note,priority:"1"});}
  playback(callId:string){return rpc<{playback_url:string;expires_in:number;cacheable:false}>(`/codestra/call-workspace/v1/calls/${encodeURIComponent(callId)}/recording/playback`);}
}

export const workspaceService=new WorkspaceService();
