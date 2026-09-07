import {rpc} from "./workspace";

export interface SupervisorAgent {agent_id:number;name:string;extension:string;status:string;campaigns:string[];call_id:string|null;call_started_at:string|null;customer:string|null;}
export interface SupervisorDashboard {agents:SupervisorAgent[];counts:Record<string,number>;queue_metrics:{available:boolean;reason?:string};}
export interface CallbackAgentMetric {agent_id:string;scheduled:number;completed:number;missed:number;overdue:number;completion_rate:number;average_lateness_seconds:number;}
export interface CallbackSupervisorDashboard {counts:Record<string,number>;agents:CallbackAgentMetric[];}
export interface CallbackCampaignMetric {campaign_id:string;scheduled:number;due:number;completed:number;missed:number;cancelled:number;rescheduled:number;escalated:number;overdue:number;outcomes:Record<string,number>;}
export interface CallSearchItem {call_id:string;linkedid:string|null;date:string;agent:string;agent_id:number;campaign:string;direction:string;phone:string;customer:string|null;disposition:string|null;duration:number;recording_available:boolean;}
export interface CallDetail {call:{call_id:string;linkedid:string|null;correlation_id:string;state:string;sequence:number;direction:string;phone:string;campaign:string;agent:string;extension:string;customer:string|null;contact_id:number|null;lead:string|null;lead_id:number|null;ringing_at:string|null;answered_at:string|null;connected_at:string|null;ended_at:string|null;duration:number;disposition:string|null;sub_disposition:string|null};timeline:{event:string;time:string;sequence:number;source:string;correlation_id:string}[];notes:{id:number;author:string;body:string;type:string;revision:number}[];qa:{id:number;score:number;state:string;reviewer:string;reviewed_at:string;coaching_required:boolean}[];recording:{status:string;reference:string|null;public_url:null};audit:{call_id:string;linkedid:string|null;correlation_id:string};}

export const supervisorService={
  dashboard:(signal?:AbortSignal)=>rpc<SupervisorDashboard>("/codestra/call-workspace/v1/supervisor/dashboard",{},signal),
  search:(query:Record<string,unknown>,signal?:AbortSignal)=>rpc<{items:CallSearchItem[];total:number;offset:number;limit:number}>("/codestra/call-workspace/v1/calls/search",query,signal),
  detail:(callId:string,signal?:AbortSignal)=>rpc<CallDetail>(`/codestra/call-workspace/v1/calls/${encodeURIComponent(callId)}/detail`,{},signal),
  score:(callId:string,scores:Record<string,number>,comment:string,coachingRequired:boolean)=>rpc<{review_id:number;score:number;state:string}>(`/codestra/call-workspace/v1/calls/${encodeURIComponent(callId)}/qa`,{scores,comment,coaching_required:coachingRequired,submit:true}),
  coaching:(reviewId:number,dueDate:string,comments:string)=>rpc<{coaching_id:number;state:string}>(`/codestra/call-workspace/v1/qa/${reviewId}/coaching`,{due_date:dueDate,comments}),
  callbackDashboard:async(signal?:AbortSignal)=>{const response=await fetch("/callback-api/api/v1/callbacks/dashboard/supervisor",{credentials:"include",signal});if(!response.ok)throw new Error(`Callback dashboard unavailable (${response.status})`);return response.json() as Promise<CallbackSupervisorDashboard>;},
  campaignCallbackDashboard:async(signal?:AbortSignal)=>{const response=await fetch("/callback-api/api/v1/callbacks/dashboard/campaigns",{credentials:"include",signal});if(!response.ok)throw new Error(`Campaign callback dashboard unavailable (${response.status})`);return response.json() as Promise<{campaigns:CallbackCampaignMetric[]}>;},
};
