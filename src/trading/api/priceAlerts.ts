import type { PriceAlert } from "../../types/alert";

const PREFIX = "fyxtez-demo-persistent-alerts-";
const key = (symbol: string) => `${PREFIX}${symbol.toUpperCase()}`;
function read(symbol: string): PriceAlert[] {
  try { const value = JSON.parse(localStorage.getItem(key(symbol)) ?? "[]"); return Array.isArray(value) ? value : []; }
  catch { return []; }
}
function write(symbol: string, alerts: PriceAlert[]): void { try { localStorage.setItem(key(symbol), JSON.stringify(alerts)); } catch {} }

export async function listPersistentPriceAlerts(symbol: string): Promise<PriceAlert[]> { return read(symbol); }
export async function createPersistentPriceAlert(symbol: string, alert: PriceAlert): Promise<PriceAlert> {
  write(symbol, [...read(symbol).filter((item) => item.id !== alert.id), alert]);
  return alert;
}
export async function updatePersistentPriceAlert(alert: PriceAlert): Promise<PriceAlert> {
  for (let i = 0; i < localStorage.length; i += 1) {
    const storageKey = localStorage.key(i);
    if (!storageKey?.startsWith(PREFIX)) continue;
    const symbol = storageKey.slice(PREFIX.length);
    const alerts = read(symbol);
    if (alerts.some((item) => item.id === alert.id)) { write(symbol, alerts.map((item) => item.id === alert.id ? alert : item)); break; }
  }
  return alert;
}
export async function cancelPersistentPriceAlert(alertId: string): Promise<void> {
  for (let i = 0; i < localStorage.length; i += 1) {
    const storageKey = localStorage.key(i);
    if (!storageKey?.startsWith(PREFIX)) continue;
    const symbol = storageKey.slice(PREFIX.length);
    write(symbol, read(symbol).filter((item) => item.id !== alertId));
  }
}
