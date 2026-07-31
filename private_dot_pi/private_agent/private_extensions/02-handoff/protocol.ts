import { MAX_PROTOCOL_BYTES } from "./config.ts";

export type GateRequest = { version: number; command: string; args?: string[]; dataBase64?: string };
export type GateResponse = { ok: boolean; error?: string; [key: string]: unknown };

function plainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

/** Strict, bounded single JSON request used over piped stdin. */
export function encodeGateRequest(request: GateRequest): Buffer {
  if (!Number.isSafeInteger(request.version) || typeof request.command !== "string" || !request.command || request.command.length > 64) throw new Error("invalid handoff request");
  if (request.args !== undefined && (!Array.isArray(request.args) || request.args.length > 32 || request.args.some((value) => typeof value !== "string" || value.length > 4096 || value.includes("\0")))) throw new Error("invalid handoff request arguments");
  if (request.dataBase64 !== undefined && !/^[A-Za-z0-9+/]*={0,2}$/.test(request.dataBase64)) throw new Error("invalid handoff request data");
  const value = Buffer.from(JSON.stringify(request), "utf8");
  if (value.length > MAX_PROTOCOL_BYTES) throw new Error("handoff request exceeds protocol limit");
  return value;
}

export function decodeGateResponse(data: Buffer): GateResponse {
  if (data.length === 0 || data.length > MAX_PROTOCOL_BYTES) throw new Error("invalid handoff response size");
  const text = data.toString("utf8").trim();
  if (!text || text.includes("\n")) throw new Error("handoff helper returned multiple responses");
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error("handoff helper returned invalid JSON"); }
  if (!plainObject(value) || typeof value.ok !== "boolean" || (value.error !== undefined && typeof value.error !== "string")) throw new Error("handoff helper returned invalid response");
  return value as GateResponse;
}
