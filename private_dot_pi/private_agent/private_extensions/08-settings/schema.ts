export function boundedSafeInteger(value: unknown, fallback: number, minimum: number, maximum: number): number {
  return Number.isSafeInteger(value) && (value as number) >= minimum && (value as number) <= maximum ? value as number : fallback;
}

export function positiveSafeInteger(value: unknown, fallback: number, maximum: number): number {
  return Number.isSafeInteger(value) && (value as number) > 0 ? Math.min(value as number, maximum) : fallback;
}

export function nonNegativeSafeInteger(value: unknown, fallback: number, maximum: number): number {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? Math.min(value as number, maximum) : fallback;
}

export function stringSetting(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value : fallback;
}
