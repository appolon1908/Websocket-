// @vitest-environment jsdom
import {cleanup,fireEvent,render,screen} from "@testing-library/react";
import {afterEach,describe,expect,it,vi} from "vitest";
import {workspaceService,type Workspace} from "../../workspace";
import {CallWorkspace} from "./CallWorkspace";

const workspace:Workspace={call_id:"test-call",correlation_id:"corr",state:"completed",previous_state:"connected",sequence:4,direction:"inbound",caller_number:"+18095550100",campaign:"TEST_SYN",business_unit:"COD",extension:"6101",ringing_at:"2026-08-22T12:00:00Z",answered_at:"2026-08-22T12:00:05Z",ended_at:"2026-08-22T12:01:05Z",customer:{id:1,name:"Synthetic Customer"},company:null,lead:{id:2,name:"Synthetic Lead"},opportunity:null,crm:{lead_id:2,contact_id:1,email:"synthetic@example.invalid",phone:"+18095550100"},timeline:[{event:"ringing",time:"2026-08-22T12:00:00Z",source:"middleware",actor:null,sequence:1,correlation_id:"corr"},{event:"completed",time:"2026-08-22T12:01:05Z",source:"middleware",actor:null,sequence:4,correlation_id:"corr"}],notes:[],dispositions:[{code:"CALLBACK",name:"Callback",requires_note:true,children:[{code:"PRICING",name:"Needs pricing",requires_callback:true,requires_task:false}]}],callbacks:[],note_templates:[{id:1,name:"Interested",body:"Interested in service"}],recording_status:"disabled",match_status:"exact"};

describe("professional call workspace",()=>{
  afterEach(()=>{cleanup();vi.restoreAllMocks();});
  it("renders customer context, timeline, accessible notes and wrap-up",()=>{
    render(<CallWorkspace workspace={workspace} onRefresh={vi.fn()}/>);
    expect(screen.getByRole("heading",{name:"Synthetic Customer"})).toBeTruthy();
    expect(screen.getByText("ringing")).toBeTruthy();expect(screen.getByLabelText("Live notes")).toBeTruthy();expect(screen.getByLabelText("Disposition")).toBeTruthy();
    expect((screen.getByRole("button",{name:"Send SMS"}) as HTMLButtonElement).disabled).toBe(true);expect((screen.getByRole("button",{name:"Send email"}) as HTMLButtonElement).disabled).toBe(true);
  });
  it("submits a campaign-scoped disposition exactly once",async()=>{
    const disposition=vi.spyOn(workspaceService,"disposition").mockResolvedValue({saved:true});
    const refresh=vi.fn().mockResolvedValue(undefined);render(<CallWorkspace workspace={workspace} onRefresh={refresh}/>);
    fireEvent.change(screen.getByLabelText("Disposition"),{target:{value:"CALLBACK"}});fireEvent.change(screen.getByLabelText("Sub-disposition"),{target:{value:"PRICING"}});fireEvent.click(screen.getByRole("button",{name:"Complete wrap-up"}));
    await vi.waitFor(()=>expect(disposition).toHaveBeenCalledTimes(1));expect(disposition).toHaveBeenCalledWith("test-call","CALLBACK","PRICING","");
  });
});
