import { demoSizing, setDemoSizing } from "../demoStore";

export type SizingConfig = {
  margin_pct: number;
  leverage_safety: number;
  max_leverage: number;
};

export async function getSizing(_signal?: AbortSignal): Promise<SizingConfig> {
  return demoSizing();
}

export async function updateSizing(sizing: SizingConfig, _signal?: AbortSignal): Promise<SizingConfig> {
  return setDemoSizing(sizing);
}
