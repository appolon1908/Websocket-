import AxeBuilder from "@axe-core/playwright";
import {expect,test} from "@playwright/test";

test.beforeEach(async({page})=>{
  await page.route("**/oauth2/userinfo",route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({preferredUsername:"synthetic.agent.test.syn.6101",sub:"46c6027f-1ea8-4010-a104-5b908aabb715"})}));
  await page.route("**/realtime-api/api/v1/realtime/sessions",route=>route.fulfill({status:201,contentType:"application/json",body:JSON.stringify({session_id:"a11y",expires_at:new Date(Date.now()+45000).toISOString(),ws_url:"wss://api.codestra.agency/ws/agent",ticket:"a11y-ticket"})}));
  await page.routeWebSocket("wss://api.codestra.agency/ws/agent",socket=>socket.onMessage(()=>socket.send(JSON.stringify({type:"authenticated"}))));
  await page.route("**/codestra/call-control/v1/current",route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({jsonrpc:"2.0",id:"a11y",result:null})}));
});

test("agent workspace has no WCAG A/AA automated violations",async({page})=>{
  await page.goto("/");await expect(page.getByTestId("realtime-status")).toContainText("Connected");
  const results=await new AxeBuilder({page}).withTags(["wcag2a","wcag2aa","wcag21a","wcag21aa"]).analyze();
  expect(results.violations,JSON.stringify(results.violations.map(item=>({id:item.id,impact:item.impact,nodes:item.nodes.map(node=>node.target)})),null,2)).toEqual([]);
});

test("active call workspace has no WCAG A/AA automated violations",async({page})=>{
  const call={call_id:"a11y-call",correlation_id:"a11y-corr",state:"completed",previous_state:"connected",sequence:4,direction:"inbound",caller_number:"+18095550100",campaign:"TEST_SYN",business_unit:"COD",extension:"6101",ringing_at:"2026-08-22T12:00:00Z",answered_at:"2026-08-22T12:00:05Z",ended_at:"2026-08-22T12:01:00Z",customer:{id:1,name:"Synthetic Customer"},company:null,lead:{id:2,name:"Synthetic Lead"},opportunity:null,crm:{lead_id:2,contact_id:1,email:"synthetic@example.invalid",phone:"+18095550100"},timeline:[{event:"call.ringing",time:"2026-08-22T12:00:00Z",source:"middleware",actor:null,sequence:1,correlation_id:"a11y-corr"}],notes:[],dispositions:[{code:"CALLBACK",name:"Callback",requires_note:false,children:[]}],callbacks:[],note_templates:[],recording_status:"disabled",match_status:"exact"};
  await page.unroute("**/codestra/call-control/v1/current");
  await page.route("**/codestra/call-control/v1/current",route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({jsonrpc:"2.0",id:"a11y",result:{call_id:"a11y-call"}})}));
  await page.route("**/codestra/call-control/v1/calls/a11y-call/workspace",route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({jsonrpc:"2.0",id:"a11y",result:call})}));
  await page.goto("/");await expect(page.getByRole("heading",{name:"Synthetic Customer"})).toBeVisible();
  const results=await new AxeBuilder({page}).withTags(["wcag2a","wcag2aa","wcag21a","wcag21aa"]).analyze();
  expect(results.violations,JSON.stringify(results.violations.map(item=>({id:item.id,impact:item.impact,nodes:item.nodes.map(node=>node.target)})),null,2)).toEqual([]);
});
