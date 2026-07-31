import { ENV } from "../config/env";

/**
 * Shared RiseX REST envelope + fetch helpers, used by both the read layer
 * (`lib/risex.ts`) and the signing layer (`lib/agent.ts`). Every shape here
 * was confirmed with live requests against `ENV.apiUrl` (docs/tasks.md task 0/3).
 */

interface ApiEnvelope<T> {
  data: T;
  request_id: string;
}

interface ApiErrorEnvelope {
  error: { code: string; message: string };
}

function unwrap<T>(path: string, ok: boolean, statusText: string, body: unknown): T {
  const envelope = body as ApiEnvelope<T> | ApiErrorEnvelope;
  if (!ok || (envelope && typeof envelope === "object" && "error" in envelope)) {
    const message =
      envelope && typeof envelope === "object" && "error" in envelope
        ? envelope.error.message
        : statusText;
    throw new Error(`RiseX API error (${path}): ${message}`);
  }
  return (envelope as ApiEnvelope<T>).data;
}

export async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(`${ENV.apiUrl}${path}`);
  const body = await res.json();
  return unwrap<T>(path, res.ok, res.statusText, body);
}

export async function apiPost<T>(path: string, payload: unknown): Promise<T> {
  const res = await fetch(`${ENV.apiUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await res.json();
  return unwrap<T>(path, res.ok, res.statusText, body);
}
