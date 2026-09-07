import { useEffect, useState } from "react";

export function useSingleTab(): boolean {
  const [duplicate, setDuplicate] = useState(false);
  useEffect(() => {
    const channel = new BroadcastChannel("codestra-webphone-session");
    const id = crypto.randomUUID();
    channel.onmessage = event => {
      if (event.data?.type === "probe") channel.postMessage({ type: "present", id });
      if (event.data?.type === "present" && event.data.id !== id) setDuplicate(true);
    };
    channel.postMessage({ type: "probe", id });
    return () => channel.close();
  }, []);
  return duplicate;
}
