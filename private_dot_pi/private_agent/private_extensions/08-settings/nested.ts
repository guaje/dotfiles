export function getNested<T>(settings: Record<string, unknown>, path: string): T | undefined {
  const parts = path.split(".");
  let current: unknown = settings;
  for (const part of parts) {
    if (current !== null && typeof current === "object" && !Array.isArray(current)) {
      current = (current as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }
  return current as T | undefined;
}
