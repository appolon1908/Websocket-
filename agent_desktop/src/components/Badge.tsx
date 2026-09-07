import type { PropsWithChildren } from "react";
export function Badge({tone="neutral",children}:PropsWithChildren<{tone?:"neutral"|"good"|"warn"|"info"}>){return <span className={`badge ${tone}`}>{children}</span>}
