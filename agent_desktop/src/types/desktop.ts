export type AgentStatus = "Ready" | "On Call" | "After Call" | "Paused";
export interface Lead { id:string; name:string; phoneMasked:string; email:string; company:string; score:number; source:string; owner:string; closer:string; campaign:string; timezone:string; tags:string[]; notes:string; }
export interface CallRecord { id:string; when:string; duration:string; result:string; agent:string; }
export interface Notification { id:string; level:"info"|"warning"|"success"; message:string; time:string; read:boolean; }
export interface Agent { id:string; name:string; role:string; status:AgentStatus; activeCall?:string; quality:number; }
export interface AiInsight { transcript:string[]; sentiment:string; confidence:number; nextQuestion:string; objection:string; disclosure:string; summary:string; }
export interface DesktopData { lead:Lead; history:CallRecord[]; notifications:Notification[]; team:Agent[]; ai:AiInsight; }
