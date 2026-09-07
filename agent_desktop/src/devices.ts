export interface AudioDevice { deviceId: string; label: string; }

export async function microphonePermission(): Promise<PermissionState | "unsupported"> {
  try { return (await navigator.permissions.query({ name: "microphone" as PermissionName })).state; }
  catch { return "unsupported"; }
}

export async function audioDevices(): Promise<{ inputs: AudioDevice[]; outputs: AudioDevice[] }> {
  const devices = await navigator.mediaDevices.enumerateDevices();
  const map = (device: MediaDeviceInfo, index: number): AudioDevice => ({
    deviceId: device.deviceId, label: device.label || `${device.kind === "audioinput" ? "Microphone" : "Speaker"} ${index + 1}`
  });
  return {
    inputs: devices.filter(x => x.kind === "audioinput").map(map),
    outputs: devices.filter(x => x.kind === "audiooutput").map(map)
  };
}

export async function recordMicrophone(deviceId: string, durationMs = 3000): Promise<Blob> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: deviceId ? { deviceId: { exact: deviceId } } : true });
  const chunks: Blob[] = []; const recorder = new MediaRecorder(stream);
  recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
  return new Promise((resolve, reject) => {
    recorder.onerror = () => reject(new Error("Microphone recording failed"));
    recorder.onstop = () => { stream.getTracks().forEach(x => x.stop()); resolve(new Blob(chunks, { type: recorder.mimeType })); };
    recorder.start(); window.setTimeout(() => recorder.stop(), durationMs);
  });
}
