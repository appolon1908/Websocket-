import type { PropsWithChildren, ReactNode } from "react";
export function Card({title,action,children,className=""}:PropsWithChildren<{title:string;action?:ReactNode;className?:string}>){return <section className={`module ${className}`}><header className="module-title"><h2>{title}</h2>{action}</header>{children}</section>}
