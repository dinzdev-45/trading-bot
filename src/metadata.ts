import type { Socials } from "./types.js";

const isLink = (v: unknown): v is string => typeof v === "string" && v.trim().length > 3;

export function extractSocials(meta: unknown): Socials {
  const m = (meta ?? {}) as Record<string, unknown>;
  const out: Socials = {};
  if (isLink(m.twitter)) out.twitter = m.twitter.trim();
  if (isLink(m.telegram)) out.telegram = m.telegram.trim();
  if (isLink(m.website)) out.website = m.website.trim();
  return out;
}

/** Fetch token metadata JSON (usually IPFS) and pull out social links. Returns null on failure. */
export async function fetchSocials(uri: string, timeoutMs: number): Promise<Socials | null> {
  if (!uri) return null;
  try {
    const res = await fetch(uri, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    return extractSocials(await res.json());
  } catch {
    return null;
  }
}
