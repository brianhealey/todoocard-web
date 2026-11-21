import { useEffect, useMemo, useState } from 'react';
import { TodooCardClient, type AdvSnapshot, type AdvWatchState, type DeviceInfo, type LogEntry } from '../lib/ble';

let singleton: TodooCardClient | null = null;
export function getClient(): TodooCardClient {
  if (!singleton) singleton = new TodooCardClient();
  return singleton;
}

export interface AdvState {
  watch: AdvWatchState;
  error: string | null;
  snapshots: AdvSnapshot[];
}

/** One client, one connection: every tab reads the same state from here. */
export function useClient() {
  const client = useMemo(getClient, []);
  const [info, setInfo] = useState<DeviceInfo | null>(client.info);
  const [connected, setConnected] = useState(client.connected);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [adv, setAdv] = useState<AdvState>({ watch: client.advWatch, error: client.advWatchError, snapshots: client.advertisements });

  useEffect(() => {
    const onInfo = (e: Event) => setInfo({ ...((e as CustomEvent<DeviceInfo | null>).detail as DeviceInfo) });
    const onLog = (e: Event) => setLog((l) => [...l.slice(-499), (e as CustomEvent<LogEntry>).detail]);
    const onDisc = () => setConnected(false);
    const onAdv = () => setAdv({ watch: client.advWatch, error: client.advWatchError, snapshots: client.advertisements.map((a) => ({ ...a })) });
    client.addEventListener('info', onInfo);
    client.addEventListener('log', onLog);
    client.addEventListener('disconnected', onDisc);
    client.addEventListener('advertisement', onAdv);
    const t = setInterval(() => setConnected(client.connected), 1000);
    return () => {
      client.removeEventListener('info', onInfo);
      client.removeEventListener('log', onLog);
      client.removeEventListener('disconnected', onDisc);
      client.removeEventListener('advertisement', onAdv);
      clearInterval(t);
    };
  }, [client]);

  return { client, info, connected, log, adv, setConnected, clearLog: () => setLog([]) };
}
