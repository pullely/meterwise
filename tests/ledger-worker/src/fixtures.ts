/* eslint-disable @typescript-eslint/no-explicit-any -- test payloads are asserted field by field */
import { route } from "@ledger-worker/router";
import { orgPublicId } from "@ledger-worker/ids";
import { ORG_A, ORG_B, KEY_A, as, json, type TestWorld } from "./harness";

export const ORG = orgPublicId(ORG_A);
export const OTHER_ORG = orgPublicId(ORG_B);
const BASE = "https://ledger.internal";

export function call(w: TestWorld, path: string, init: RequestInit = {}): Promise<Response> {
  return route(new Request(`${BASE}${path}`, init), w.env);
}

export function get(w: TestWorld, path: string, who: string): Promise<Response> {
  return call(w, path, { headers: as(who) });
}

export function send(w: TestWorld, path: string, who: string, body: unknown, method = "POST"): Promise<Response> {
  return call(w, path, {
    method,
    headers: { ...as(who), "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

export async function ok(res: Response, status = 200): Promise<Record<string, any>> {
  const body = await json(res);
  if (res.status !== status) throw new Error(`expected ${status}, got ${res.status}: ${JSON.stringify(body)}`);
  return body.data;
}

let n = 0;
/** A valid event with a fresh eventId; override any field. */
export function ev(over: Record<string, unknown> = {}): Record<string, unknown> {
  n += 1;
  return {
    eventId: `evt-${n}-${Math.random().toString(36).slice(2, 10)}`,
    tenant: "acme",
    feature: "summarize",
    user: "u-1",
    provider: "openai",
    model: "gpt-4o",
    inputTokens: 1000,
    outputTokens: 500,
    latencyMs: 820,
    ...over,
  };
}

export function ingest(w: TestWorld, events: unknown[], who = KEY_A, org = ORG): Promise<Response> {
  return send(w, `/v1/organizations/${org}/llm-events`, who, { events });
}

export async function costs(w: TestWorld, query: string, who = KEY_A, org = ORG): Promise<Record<string, any>> {
  return ok(await get(w, `/v1/organizations/${org}/llm-costs?${query}`, who));
}

export function eventCount(w: TestWorld): number {
  return (w.db.prepare("SELECT COUNT(*) AS n FROM ledger_events").get() as { n: number }).n;
}
