import {useEffect,useRef,useState} from "react";
import {workspaceService} from "./workspace";

export type SaveState="idle"|"dirty"|"saving"|"saved"|"error";

export function useAutosaveNote(callId:string|undefined,initial:string,noteId?:number,delay=750){
  const [body,setBody]=useState(initial),[state,setState]=useState<SaveState>("idle"),[revision,setRevision]=useState(noteId);
  const hydrated=useRef(false),lastSaved=useRef(initial),generation=useRef(0);
  useEffect(()=>{
    generation.current+=1;lastSaved.current=initial;setRevision(noteId);hydrated.current=true;setState("idle");
    const recovered=callId?sessionStorage.getItem(`codestra:note:${callId}`):null;
    setBody(recovered??initial);
  },[callId,initial,noteId]);
  useEffect(()=>{
    if(!callId||!hydrated.current||body===lastSaved.current)return;
    setState("dirty");sessionStorage.setItem(`codestra:note:${callId}`,body);
    const clientRevision=crypto.randomUUID(),requestGeneration=generation.current;
    const timer=window.setTimeout(()=>{setState("saving");void workspaceService.saveNote(callId,body,{noteId:revision,clientRevision}).then(result=>{
      if(requestGeneration!==generation.current)return;
      lastSaved.current=body;setRevision(result.note_id);setState("saved");sessionStorage.removeItem(`codestra:note:${callId}`);
    }).catch(()=>{if(requestGeneration===generation.current)setState("error");});},delay);
    return()=>window.clearTimeout(timer);
  },[body,callId,delay,revision]);
  return{body,setBody,state,noteId:revision};
}
