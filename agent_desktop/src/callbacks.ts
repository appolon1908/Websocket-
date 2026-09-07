export interface CallbackChange {
  expected_version: number;
  snooze_minutes?: number;
}

async function command(callbackId: string, action: string, body: CallbackChange): Promise<void> {
  const response = await fetch(`/callback-api/api/v1/control/callbacks/${encodeURIComponent(callbackId)}/${action}`, {
    method: "POST", credentials: "include",
    headers: {"Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID(), "X-Correlation-ID": crypto.randomUUID()},
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`Callback ${action} failed (${response.status})`);
}

export const callbackService = {
  start: (id: string, version: number) => command(id, "call-now", {expected_version: version}),
  snooze: (id: string, version: number, minutes: number) => command(id, "snooze", {expected_version: version, snooze_minutes: minutes}),
};
