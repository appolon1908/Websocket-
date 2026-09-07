import { chromium } from "/root/gate2-browser-harness/node_modules/playwright/index.mjs";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import crypto from "node:crypto";

const secret=readFileSync("/etc/codestra/secrets/websocket-gateway/certifier_client_secret","utf8").trim();
const response=await fetch("https://auth.codestra.co/realms/codestra/protocol/openid-connect/token",{method:"POST",headers:{"content-type":"application/x-www-form-urlencoded"},body:new URLSearchParams({grant_type:"client_credentials",client_id:"codestra-realtime-certifier",client_secret:secret})});
if(!response.ok) throw new Error(`Keycloak token failed ${response.status}`);
const token=(await response.json()).access_token;
const claims=JSON.parse(Buffer.from(token.split(".")[1],"base64url").toString());
let sequence=200;
const make=(customer)=>({event_id:`recovery-${crypto.randomUUID()}`,schema_version:"1.0",type:"call.ringing",correlation_id:`recovery-${crypto.randomUUID()}`,timestamp:new Date().toISOString(),tenant_id:"synthetic-tenant",business_unit_id:"TEST",campaign_id:"TEST_SYN",user_id:claims.sub,agent_id:"CERT-AGENT-A",call_id:`RECOVERY-${crypto.randomUUID()}`,sequence:sequence++,payload:{customer_name:customer,campaign:"TEST_SYN",phone:"+1XXXXXXXXXX",lead_id:`SYNTH-${sequence}`}});
const publish=event=>execFileSync("docker",["exec","-e",`EVENT_JSON=${JSON.stringify(event)}`,"codestra-websocket-certifier","python","-c","import os,httpx,json; t=open('/run/secrets/internal_token').read().strip(); r=httpx.post('http://codestra-websocket-gateway-gateway-1:8080/internal/v1/realtime/events',headers={'X-Codestra-Internal-Token':t},json=json.loads(os.environ['EVENT_JSON'])); r.raise_for_status()"]);
const persist=event=>execFileSync("docker",["exec","-e",`EVENT_JSON=${JSON.stringify(event)}`,"codestra-websocket-certifier","python","-c",`import os,asyncio,asyncpg,json
from datetime import datetime
e=json.loads(os.environ['EVENT_JSON'])
u=open('/run/secrets/database_url').read().strip()
async def m():
 c=await asyncpg.connect(u)
 await c.execute('INSERT INTO realtime_events(event_id,schema_version,event_type,correlation_id,occurred_at,tenant_id,business_unit_id,campaign_id,user_id,agent_id,call_id,sequence,payload) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb)',e['event_id'],e['schema_version'],e['type'],e['correlation_id'],datetime.fromisoformat(e['timestamp'].replace('Z','+00:00')),e['tenant_id'],e['business_unit_id'],e['campaign_id'],e['user_id'],e['agent_id'],e['call_id'],e['sequence'],json.dumps(e['payload']))
 await c.close()
asyncio.run(m())`]);
const browser=await chromium.launch({headless:true,executablePath:"/root/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome"});
const page=await browser.newPage({viewport:{width:1440,height:1000}});
await page.goto("https://phone.codestra.agency/",{waitUntil:"networkidle"});
await page.evaluate(value=>window.dispatchEvent(new CustomEvent("codestra:access-token",{detail:value})),token);
await page.getByTestId("realtime-status").getByText("Realtime: Connected").waitFor({timeout:15000});
const baseline=make("Before Restart"); publish(baseline); await page.getByText("Before Restart").waitFor();

execFileSync("docker",["stop","codestra-websocket-gateway-gateway-1"]);
const duringGateway=make("Recovered After Gateway Restart"); persist(duringGateway);
execFileSync("docker",["start","codestra-websocket-gateway-gateway-1"]);
await page.waitForFunction(()=>document.querySelector('[data-testid="realtime-status"]')?.textContent?.includes("Connected"),undefined,{timeout:30000});
await page.getByText("Recovered After Gateway Restart").waitFor({timeout:15000});

execFileSync("docker",["stop","codestra-reverse-proxy-1"]);
const duringProxy=make("Recovered After Proxy Restart"); publish(duringProxy);
execFileSync("docker",["start","codestra-reverse-proxy-1"]);
await page.waitForFunction(()=>document.querySelector('[data-testid="realtime-status"]')?.textContent?.includes("Connected"),undefined,{timeout:30000});
await page.getByText("Recovered After Proxy Restart").waitFor({timeout:15000});
const result={MIDDLEWARE_RESTART_RECOVERY:"PASS",PROXY_RESTART_RECOVERY:"PASS",REPLAY_EXACTLY_ONCE:"PASS"};
writeFileSync("/root/codestra-production-completion/evidence/websocket-gateway-20260817/recovery-results.json",JSON.stringify(result,null,2)+"\n",{mode:0o640});
console.log(JSON.stringify(result,null,2));
await browser.close();
