// @vitest-environment jsdom
import {cleanup,fireEvent,render,screen} from "@testing-library/react";
import {afterEach,describe,expect,it,vi} from "vitest";
import {supervisorService,type CallDetail} from "../../supervisor";
import {SupervisorModule} from "./SupervisorModule";

const detail:CallDetail={call:{call_id:"call-1",linkedid:"linked-1",correlation_id:"corr-1",state:"completed",sequence:4,direction:"inbound",phone:"+18095550100",campaign:"TEST_SYN",agent:"Synthetic Agent",extension:"6101",customer:"Synthetic Customer",contact_id:1,lead:"Synthetic Lead",lead_id:2,ringing_at:null,answered_at:null,connected_at:null,ended_at:null,duration:60,disposition:"CALLBACK",sub_disposition:null},timeline:[{event:"call.completed",time:"2026-08-22T12:00:00Z",sequence:4,source:"middleware",correlation_id:"corr-1"}],notes:[],qa:[],recording:{status:"disabled",reference:null,public_url:null},audit:{call_id:"call-1",linkedid:"linked-1",correlation_id:"corr-1"}};

describe("supervisor workspace",()=>{
  afterEach(()=>{cleanup();vi.restoreAllMocks();});
  it("renders only server-returned agents and opens scoped call detail",async()=>{
    vi.spyOn(supervisorService,"dashboard").mockResolvedValue({agents:[{agent_id:1,name:"Synthetic Agent",extension:"6101",status:"completed",campaigns:["TEST_SYN"],call_id:"call-1",call_started_at:null,customer:"Synthetic Customer"}],counts:{completed:1},queue_metrics:{available:false,reason:"No authoritative source"}});
    vi.spyOn(supervisorService,"search").mockResolvedValue({items:[],total:0,offset:0,limit:50});
    vi.spyOn(supervisorService,"detail").mockResolvedValue(detail);
    render(<SupervisorModule/>);
    const agent=await screen.findByRole("button",{name:/Synthetic Agent/});fireEvent.click(agent);
    expect(await screen.findByText("Call ID")).toBeTruthy();expect(screen.getByText("call-1")).toBeTruthy();expect(screen.getByText(/public URL: none/)).toBeTruthy();
  });
  it("shows RBAC denial without leaking a stack trace",async()=>{
    vi.spyOn(supervisorService,"dashboard").mockRejectedValue(new Error("Supervisor access is required."));
    vi.spyOn(supervisorService,"search").mockRejectedValue(new Error("Supervisor access is required."));
    render(<SupervisorModule/>);expect((await screen.findByRole("alert")).textContent).toContain("Supervisor access is required.");
    expect(screen.queryByText(/Traceback|stack/i)).toBeNull();
  });
});
