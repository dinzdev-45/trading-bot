import type { CoinInfo, Socials } from "./types.js";

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

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);

/**
 * Token details from pump.fun's public coin API, for tokens the bot did not see launch (copy trading).
 * Unofficial endpoint: it may change or rate-limit; returns null on any failure.
 */
export async function fetchCoinInfo(mint: string, baseUrl: string, timeoutMs: number): Promise<CoinInfo | null> {
  if (!baseUrl) return null;
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/coins/${encodeURIComponent(mint)}`, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: "application/json" },
    });
    if (!res.ok) return null;
    const j = (await res.json()) as Record<string, unknown>;
    const socials = extractSocials(j);
    return {
      name: str(j.name),
      symbol: str(j.symbol),
      uri: str(j.metadata_uri) ?? str(j.uri),
      creator: str(j.creator),
      // The API usually includes the links; if not, look them up from the metadata URI.
      socials: socials.twitter || socials.telegram || socials.website ? socials : undefined,
    };
  } catch {
    return null;
  }
}
