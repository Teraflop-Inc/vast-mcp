import type { Quote } from "./guard.js";

// Where quotes and committed spend live. In memory for the local server; a
// hosted deployment swaps in its platform's storage (Redis, Durable Objects, KV)
// so state survives restarts and is shared across server instances.
// Everything is keyed by owner, so one user can never see or redeem another's quote.
export interface Store {
  putQuote(owner: string, quote: Quote, ttlMs: number): Promise<void>;
  // Returns the quote and deletes it in one step, so a quote can be used once.
  takeQuote(owner: string, quoteId: string): Promise<Quote | undefined>;
  addSpend(owner: string, amountUsd: number, atMs: number): Promise<void>;
  spendSince(owner: string, sinceMs: number): Promise<number>;
}

export class MemoryStore implements Store {
  private quotes = new Map<string, { quote: Quote; expiresAt: number }>();
  private spend = new Map<string, { amount: number; at: number }[]>();

  constructor(private readonly now: () => number = Date.now) {}

  async putQuote(owner: string, quote: Quote, ttlMs: number): Promise<void> {
    this.prune();
    this.quotes.set(`${owner}:${quote.quoteId}`, { quote, expiresAt: this.now() + ttlMs });
  }

  async takeQuote(owner: string, quoteId: string): Promise<Quote | undefined> {
    const key = `${owner}:${quoteId}`;
    const entry = this.quotes.get(key);
    this.quotes.delete(key);
    return entry?.quote;
  }

  async addSpend(owner: string, amountUsd: number, atMs: number): Promise<void> {
    const rows = this.spend.get(owner) ?? [];
    rows.push({ amount: amountUsd, at: atMs });
    this.spend.set(owner, rows);
  }

  async spendSince(owner: string, sinceMs: number): Promise<number> {
    return (this.spend.get(owner) ?? []).filter((r) => r.at >= sinceMs).reduce((s, r) => s + r.amount, 0);
  }

  private prune(): void {
    const t = this.now();
    for (const [k, v] of this.quotes) if (v.expiresAt < t) this.quotes.delete(k);
  }
}
