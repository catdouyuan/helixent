/**
 * Reads a positive integer from the environment, falling back when unset/invalid.
 * @param name - The environment variable name.
 * @param fallback - The fallback value.
 * @returns The parsed value or fallback.
 */
export function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
