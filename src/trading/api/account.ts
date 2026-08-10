import { demoBalance } from "../demoStore";

/** Browser-local paper balance. No account or backend request is made. */
export async function getAvailableBalance(_signal?: AbortSignal): Promise<number> {
  return demoBalance();
}
