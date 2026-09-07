// @vitest-environment jsdom
import {act,cleanup,renderHook} from "@testing-library/react";
import {afterEach,describe,expect,it,vi} from "vitest";
import {workspaceService} from "./workspace";
import {useAutosaveNote} from "./useAutosaveNote";

describe("live note autosave",()=>{
  afterEach(()=>{cleanup();vi.restoreAllMocks();vi.useRealTimers();sessionStorage.clear();});
  it("saves one revision and does not loop after acknowledgement",async()=>{
    vi.useFakeTimers();
    const save=vi.spyOn(workspaceService,"saveNote").mockResolvedValue({saved:true,duplicate:false,note_id:42,revision:2});
    const {result}=renderHook(()=>useAutosaveNote("call-1","original",7,500));
    act(()=>result.current.setBody("updated"));
    expect(sessionStorage.getItem("codestra:note:call-1")).toBe("updated");
    await act(async()=>{await vi.advanceTimersByTimeAsync(500);});
    expect(save).toHaveBeenCalledTimes(1);expect(result.current.state).toBe("saved");expect(result.current.noteId).toBe(42);
    await act(async()=>{await vi.advanceTimersByTimeAsync(2000);});
    expect(save).toHaveBeenCalledTimes(1);expect(sessionStorage.getItem("codestra:note:call-1")).toBeNull();
  });
  it("recovers a failed draft only inside the browser session",()=>{
    sessionStorage.setItem("codestra:note:call-2","recovered draft");
    const {result}=renderHook(()=>useAutosaveNote("call-2","server text",8,500));
    expect(result.current.body).toBe("recovered draft");expect(localStorage.getItem("codestra:note:call-2")).toBeNull();
  });
});
