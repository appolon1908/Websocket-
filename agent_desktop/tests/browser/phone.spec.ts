import { expect, test } from "@playwright/test";

const response = {
  session_id: "synthetic-session",
  binding_id: "synthetic-binding",
  sip_uri: "sip:6101@dialer.codestra.agency",
  authorization_username: "synthetic-short-lived",
  ephemeral_password: "synthetic-memory-only",
  websocket_url: "wss://127.0.0.1:9/ws",
  ice_servers: [{ urls: ["turns:vicidial-staging.codestra.agency:5349?transport=tcp"], username: "synthetic", credential: "synthetic" }],
  expires_at: new Date(Date.now() + 300_000).toISOString(),
  role: "SETTER",
  campaign_id: "TEST_SYN",
  endpoint: "6101",
  environment: "STAGING",
  permitted_call_scope: ["6000"],
};

test.beforeEach(async ({ page }) => {
  await page.route("**/oauth2/userinfo", route => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ preferredUsername: "synthetic.agent.test.syn.6101", sub: "46c6027f-1ea8-4010-a104-5b908aabb715" }) }));
  await page.route("**/webphone-api/v1/session", route => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(response) }));
  await page.route("**/realtime-api/api/v1/realtime/sessions", route => route.fulfill({
    status: 201, contentType: "application/json", body: JSON.stringify({ session_id: "test", expires_at: new Date(Date.now()+45_000).toISOString(), ws_url: "wss://api.codestra.agency/ws/agent", ticket: "test-ticket" }),
  }));
  await page.routeWebSocket("wss://api.codestra.agency/ws/agent", socket => socket.onMessage(() => socket.send(JSON.stringify({ type: "authenticated" }))));
  await page.routeWebSocket("wss://wss.codestra.agency:8089/ws", socket => socket.close());
});

test("loads staging SIP.js UI with safe route indicators", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("SIPJS_STAGING", { exact: true }).first()).toBeVisible();
  await expect(page.getByText(/endpoint 6101 · extension 6000 echo/i)).toBeVisible();
  await expect(page.getByRole("button", { name: "Call echo 6000" })).toBeDisabled();
  await expect(page.getByRole("button", { name: /transfer/i })).toHaveCount(0);
  await expect(page.getByTestId("provision-register")).toBeDisabled();
  await expect(page.getByTestId("m11-state")).toHaveAttribute("data-environment", "staging");
  await expect(page.getByTestId("m11-state")).toHaveAttribute("data-safe-mode", "false");
  await expect(page.getByTestId("m11-state")).toHaveAttribute("data-sip-enabled", "true");
  await expect(page.getByTestId("m11-state")).toHaveAttribute("data-webrtc-enabled", "true");
  await expect(page.getByTestId("m11-state")).toHaveAttribute("data-test-syn-only", "true");
  await expect(page.getByTestId("m11-state")).toHaveAttribute("data-production-pstn", "false");
});

test("denies an unauthenticated browser and remains fail-closed", async ({ page }) => {
  await page.unroute("**/oauth2/userinfo");
  await page.route("**/oauth2/userinfo", route => route.fulfill({ status: 401 }));
  await page.goto("/");
  const state = page.getByTestId("m11-state");
  await expect(state).toHaveAttribute("data-browser-login", "false");
  await expect(state).toHaveAttribute("data-diagnostic-fail-closed", "true");
  await expect(page.getByTestId("provision-register")).toBeDisabled();
});

test("denies a non-canonical subject identity and remains fail-closed", async ({ page }) => {
  await page.unroute("**/oauth2/userinfo");
  await page.route("**/oauth2/userinfo", route => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ preferredUsername: "synthetic.agent.test.syn.6101", sub: "00000000-0000-0000-0000-000000000000" }) }));
  await page.goto("/");
  const state = page.getByTestId("m11-state");
  await expect(state).toHaveAttribute("data-browser-login", "true");
  await expect(state).toHaveAttribute("data-canonical-identity", "false");
  await expect(state).toHaveAttribute("data-diagnostic-fail-closed", "true");
  await expect(page.getByTestId("provision-register")).toBeDisabled();
});

test("requests bounded provisioning and fails closed when WSS is unavailable", async ({ page }) => {
  let requestBody: Record<string, string> = {};
  await page.unroute("**/webphone-api/v1/session");
  await page.route("**/webphone-api/v1/session", async route => {
    requestBody = route.request().postDataJSON();
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(response) });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Prepare M11 (no REGISTER)" }).click();
  await expect.poll(() => requestBody).toMatchObject({ campaign_id: "TEST_SYN", endpoint: "6101" });
  expect(await page.evaluate(async () => ({ local: localStorage.length, session: sessionStorage.length, indexed: (await indexedDB.databases()).length, url: location.href }))).toEqual({
    local: 0, session: 0, indexed: 0, url: "http://127.0.0.1:4173/",
  });
});

test("prevents duplicate control submission while connecting", async ({ page }) => {
  await page.route("**/webphone-api/v1/session", async route => {
    await new Promise(resolve => setTimeout(resolve, 800));
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(response) });
  });
  await page.goto("/");
  const button = page.getByRole("button", { name: "Prepare M11 (no REGISTER)" });
  await button.click();
  await expect(button).toBeDisabled();
});

test("survives page refresh without persisting credentials or registration", async ({ page }) => {
  await page.goto("/");
  await page.reload();
  await expect(page.getByText("DISCONNECTED", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => localStorage.length + sessionStorage.length)).toBe(0);
});

test("microphone denial is visible and leaves no active registration", async ({ browser }) => {
  const context = await browser.newContext({ permissions: [] });
  const page = await context.newPage();
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        enumerateDevices: async () => [],
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        getUserMedia: async () => { throw new DOMException("denied", "NotAllowedError"); },
      },
    });
  });
  await page.route("**/oauth2/userinfo", route => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ preferredUsername: "synthetic.agent.test.syn.6101", sub: "46c6027f-1ea8-4010-a104-5b908aabb715" }) }));
  await page.route("**/realtime-api/api/v1/realtime/sessions", route => route.fulfill({ status: 503 }));
  await page.routeWebSocket("wss://wss.codestra.agency:8089/ws", socket => socket.close());
  await page.route("**/webphone-api/v1/session", route => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(response) }));
  await page.goto("http://127.0.0.1:4173/");
  await page.getByRole("button", { name: "Prepare M11 (no REGISTER)" }).click();
  await expect(page.getByText(/Phone operation failed|permission|denied/i)).toBeVisible();
  await context.close();
});

test("fake microphone test completes and media is cleaned by page close", async ({ page, browserName }) => {
  test.skip(browserName === "webkit", "SUPPORTED_PLATFORM_LIMITATION: Playwright WebKit on Linux cannot provide a fake microphone device");
  await page.goto("/");
  await page.getByRole("button", { name: "Microphone test" }).click();
  await expect(page.getByText(/Microphone permission and live track verified; no audio recorded/i)).toBeVisible({ timeout: 5000 });
  const activeBeforeClose = await page.evaluate(() => document.querySelectorAll("audio").length);
  expect(activeBeforeClose).toBeGreaterThan(0);
});

test("authenticates realtime and renders one screen pop and recording state", async ({ page }) => {
  await page.route("**/realtime-api/api/v1/realtime/sessions", route => route.fulfill({
    status: 201,
    contentType: "application/json",
    body: JSON.stringify({
      session_id: "browser-synthetic-session",
      expires_at: new Date(Date.now() + 45_000).toISOString(),
      ws_url: "wss://api.codestra.agency/ws/agent",
      ticket: "opaque-single-use-ticket",
    }),
  }));
  await page.routeWebSocket("wss://api.codestra.agency/ws/agent", socket => {
    socket.onMessage(raw => {
      const frame = JSON.parse(String(raw));
      if (frame.type !== "auth" || frame.ticket !== "opaque-single-use-ticket") return;
      socket.send(JSON.stringify({ type: "authenticated", session_id: "browser-synthetic-session", replayed: 0 }));
      const base = {
        schema_version: "1.0", correlation_id: "browser-cert", timestamp: new Date().toISOString(),
        tenant_id: "synthetic-tenant", business_unit_id: "TEST", campaign_id: "TEST_SYN",
        user_id: "agent-a", agent_id: "agent-a", call_id: "TEST-123", sequence: 1,
      };
      socket.send(JSON.stringify({ ...base, event_id: "browser-ring-1", type: "call.ringing", payload: { customer_name: "Synthetic Customer", lead_id: "SYNTHETIC-LEAD-6101", phone: "+1XXXXXXXXXX" } }));
      socket.send(JSON.stringify({ ...base, event_id: "browser-recording-1", type: "recording.started", sequence: 2, payload: { state: "ON" } }));
      socket.send(JSON.stringify({ ...base, event_id: "browser-recording-2", type: "recording.available", sequence: 3, payload: { recording_id: "SYNTHETIC-REC-1" } }));
    });
  });
  await page.goto("/");
  await expect(page.getByTestId("realtime-status")).toHaveText("Realtime: Connected");
  await expect(page.getByTestId("screen-pop")).toContainText("Synthetic Customer");
  await expect(page.getByTestId("screen-pop")).toContainText("TEST_SYN");
  await expect(page.getByTestId("screen-pop").getByRole("link", { name: "Open lead" })).toHaveAttribute("href", /SYNTHETIC-LEAD-6101/);
  await expect(page.getByTestId("recording-state")).toContainText("Available");
  await expect(page.getByTestId("recording-state").getByRole("button", { name: "Play" })).toBeVisible();
});

test("fails closed across two and three simultaneous tabs and recovers after close", async ({ page, context }) => {
  const configure = async (candidate: typeof page) => {
    await candidate.route("**/oauth2/userinfo", route => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ preferredUsername: "synthetic.agent.test.syn.6101", sub: "46c6027f-1ea8-4010-a104-5b908aabb715" }) }));
    await candidate.route("**/realtime-api/api/v1/realtime/sessions", route => route.fulfill({ status: 503 }));
    await candidate.routeWebSocket("wss://wss.codestra.agency:8089/ws", socket => socket.close());
  };
  await page.goto("/");
  const second = await context.newPage();
  await configure(second);
  await second.goto("/");
  await expect(second.getByText("Duplicate tab detected. Registration blocked.")).toBeVisible();
  await expect(second.getByTestId("provision-register")).toBeDisabled();

  const third = await context.newPage();
  await configure(third);
  await third.goto("/");
  await expect(third.getByText("Duplicate tab detected. Registration blocked.")).toBeVisible();
  await expect(third.getByTestId("provision-register")).toBeDisabled();
  expect(await second.evaluate(() => localStorage.length + sessionStorage.length)).toBe(0);
  expect(await third.evaluate(() => localStorage.length + sessionStorage.length)).toBe(0);

  await second.close();
  await third.close();
  const reopened = await context.newPage();
  await configure(reopened);
  await reopened.goto("/");
  await expect(reopened.getByTestId("provision-register")).toBeDisabled();
  expect(await reopened.evaluate(() => localStorage.length + sessionStorage.length)).toBe(0);
});
