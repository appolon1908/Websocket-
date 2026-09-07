import { chromium } from "/root/gate2-browser-harness/node_modules/playwright/index.mjs";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import crypto from "node:crypto";

const secret = readFileSync("/etc/codestra/secrets/websocket-gateway/certifier_client_secret", "utf8").trim();
const body = new URLSearchParams({grant_type:"client_credentials",client_id:"codestra-realtime-certifier",client_secret:secret});
const tokenResponse = await fetch("https://auth.codestra.co/realms/codestra/protocol/openid-connect/token", {method:"POST",headers:{"content-type":"application/x-www-form-urlencoded"},body});
if (!tokenResponse.ok) throw new Error(`Keycloak login failed: ${tokenResponse.status}`);
const accessToken = (await tokenResponse.json()).access_token;
const claims = JSON.parse(Buffer.from(accessToken.split(".")[1], "base64url").toString("utf8"));
const runCallId = `BROWSER-CALL-${crypto.randomUUID()}`;

const publish = event => execFileSync("docker", ["exec", "-e", `EVENT_JSON=${JSON.stringify(event)}`, "codestra-websocket-certifier", "python", "-c",
  "import os,httpx; t=open('/run/secrets/internal_token').read().strip(); r=httpx.post('http://codestra-websocket-gateway-gateway-1:8080/internal/v1/realtime/events',headers={'X-Codestra-Internal-Token':t},json=__import__('json').loads(os.environ['EVENT_JSON'])); r.raise_for_status()"], {stdio:"pipe"});
const makeEvent = (type, sequence, payload) => ({event_id:`browser-${type}-${crypto.randomUUID()}`,schema_version:"1.0",type,correlation_id:`browser-${crypto.randomUUID()}`,timestamp:new Date().toISOString(),tenant_id:"synthetic-tenant",business_unit_id:"TEST",campaign_id:"TEST_SYN",user_id:claims.sub,agent_id:"CERT-AGENT-A",call_id:runCallId,sequence,payload});

const browser = await chromium.launch({headless:true, executablePath:"/root/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome"});
const page = await browser.newPage({viewport:{width:1440,height:1000}});
await page.goto("https://phone.codestra.agency/", {waitUntil:"networkidle"});
await page.evaluate(token => window.dispatchEvent(new CustomEvent("codestra:access-token", {detail:token})), accessToken);
await page.getByTestId("realtime-status").getByText("Realtime: Connected").waitFor({timeout:15000});

publish(makeEvent("call.ringing", 100, {direction:"inbound",customer_name:"Synthetic Customer",campaign:"TEST_SYN",phone:"+1XXXXXXXXXX",lead_id:"SYNTHETIC-LEAD-6101"}));
await page.getByTestId("screen-pop").getByText("Synthetic Customer").waitFor();
await page.getByTestId("screen-pop").getByText("TEST_SYN").waitFor();

publish(makeEvent("recording.started", 101, {state:"ON"}));
await page.getByTestId("recording-state").getByText("ON", {exact:true}).waitFor();
publish(makeEvent("recording.available", 102, {state:"available",recording_id:"SYNTHETIC-REC-BROWSER"}));
await page.getByTestId("recording-state").getByText("Available", {exact:true}).waitFor();
await page.getByTestId("recording-state").getByRole("button", {name:"Play"}).waitFor();

const screenshot = "/root/codestra-production-completion/evidence/websocket-gateway-20260817/browser-screen-pop-recording.png";
await page.screenshot({path:screenshot,fullPage:true});
const result = {BROWSER_TEST:"PASS",LOGIN_KEYCLOAK_TOKEN:"PASS",REALTIME_CONNECTED:"PASS",SCREEN_POP_UI:"PASS",RECORDING_ON_UI:"PASS",RECORDING_AVAILABLE_UI:"PASS",screenshot};
writeFileSync("/root/codestra-production-completion/evidence/websocket-gateway-20260817/browser-results.json", JSON.stringify(result,null,2)+"\n", {mode:0o640});
console.log(JSON.stringify(result,null,2));
await browser.close();
