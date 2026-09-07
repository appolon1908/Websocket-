export type RealtimeState = "Disconnected" | "Connecting" | "Connected" | "Reconnecting";
export type RealtimeEvidence = "ticket-requested" | "ticket-issued" | "ticket-consumed";

export interface RealtimeEvent {
  event_id: string;
  schema_version: "1.0";
  type: string;
  correlation_id: string;
  timestamp: string;
  tenant_id: string;
  business_unit_id: string;
  campaign_id: string;
  user_id: string;
  agent_id: string;
  call_id?: string;
  sequence: number;
  payload: Record<string, unknown>;
}

interface RealtimeSession { ticket:string; ws_url:string; expires_at:string; session_id:string; }
type EventHandler = (event: RealtimeEvent) => void;

export class RealtimeClient {
  private socket?: WebSocket;
  private stopped = false;
  private retries = 0;
  private reconnectTimer?: number;
  private processed = new Set<string>();
  private handler: EventHandler;
  private stateHandler: (state: RealtimeState) => void;
  private evidenceHandler: (evidence: RealtimeEvidence) => void;

  constructor(handler: EventHandler, stateHandler: (state:RealtimeState)=>void, evidenceHandler: (evidence:RealtimeEvidence)=>void = () => undefined) {
    this.handler = handler; this.stateHandler = stateHandler; this.evidenceHandler = evidenceHandler;
  }

  async connect(): Promise<void> {
    this.stopped = false;
    this.stateHandler(this.retries ? "Reconnecting" : "Connecting");
    this.evidenceHandler("ticket-requested");
    try {
      const response = await fetch("/realtime-api/api/v1/realtime/sessions", {
        method:"POST", credentials:"include", headers:{Accept:"application/json"},
      });
      if (!response.ok) throw new Error(`Realtime session denied (${response.status})`);
      const session = await response.json() as RealtimeSession;
      this.evidenceHandler("ticket-issued");
      await this.open(session);
    } catch (error) {
      if (this.stopped) throw error;
      this.scheduleReconnect();
    }
  }

  private async open(session: RealtimeSession): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(session.ws_url);
      this.socket = socket;
      const timer = window.setTimeout(() => { socket.close(); reject(new Error("Realtime authentication timed out")); }, 7000);
      socket.onopen = () => socket.send(JSON.stringify({type:"auth", ticket:session.ticket, last_event_id:localStorage.getItem("codestra:last-realtime-event") || undefined}));
      socket.onmessage = message => {
        const value = JSON.parse(String(message.data)) as RealtimeEvent | {type:string};
        if (value.type === "authenticated") { window.clearTimeout(timer); this.retries = 0; this.evidenceHandler("ticket-consumed"); this.stateHandler("Connected"); resolve(); return; }
        if (!("event_id" in value) || this.processed.has(value.event_id)) return;
        this.processed.add(value.event_id); localStorage.setItem("codestra:last-realtime-event", value.event_id); this.handler(value);
      };
      socket.onerror = () => { window.clearTimeout(timer); reject(new Error("Realtime connection failed")); };
      socket.onclose = event => {
        window.clearTimeout(timer);
        if (this.stopped || event.code === 4401 || event.code === 4403) { this.stateHandler("Disconnected"); return; }
        this.scheduleReconnect();
      };
    });
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer !== undefined) return;
    this.stateHandler("Reconnecting"); this.retries += 1;
    this.reconnectTimer = window.setTimeout(async () => {
      this.reconnectTimer = undefined;
      try { await this.connect(); }
      catch { this.scheduleReconnect(); }
    }, Math.min(10000, 250 * 2 ** Math.min(this.retries, 5)));
  }

  disconnect(): void {
    this.stopped = true;
    if (this.reconnectTimer !== undefined) window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.socket?.close(1000, "agent logout");
    this.stateHandler("Disconnected");
  }
}
