import { demoLeverage, setDemoLeverage } from "../demoStore";

export type SetLeverageResponse = { symbol?: string; leverage?: number; maxNotionalValue?: string; [key: string]: unknown };
export type CurrentLeverageResponse = { symbol: string; leverage: number };
export type MaxLeverageResponse = { symbol: string; max_leverage: number };

export async function updateLeverage(symbol: string, leverage: number): Promise<SetLeverageResponse> {
  return { symbol: symbol.toUpperCase(), leverage: setDemoLeverage(symbol, leverage), maxNotionalValue: "1000000" };
}

export async function getCurrentLeverage(symbol: string): Promise<CurrentLeverageResponse> {
  return { symbol: symbol.toUpperCase(), leverage: demoLeverage(symbol) };
}

export async function getMaxLeverage(symbol: string): Promise<MaxLeverageResponse> {
  return { symbol: symbol.toUpperCase(), max_leverage: 50 };
}
