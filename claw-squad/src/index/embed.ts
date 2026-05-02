/**
 * Local embedding client (claw-squad smart-context).
 *
 * Mirror of `claudestruct.embed`. Talks to any OpenAI-compatible
 * `/embeddings` endpoint via Node 18+'s built-in `fetch` so the
 * smart-context surface adds zero new dependencies.
 *
 * Configuration (env vars; defaults target Ollama on a GX10):
 *
 *   CLAW_SQUAD_EMBED_BASE_URL   default `http://localhost:11434/v1`
 *   CLAW_SQUAD_EMBED_MODEL      default `nomic-embed-text`
 *   CLAW_SQUAD_EMBED_API_KEY    optional; only set when a gateway gates
 *                               the route
 *
 * The wire format matches OpenAI's `/embeddings`: POST
 * `{model, input: [string, ...]}` → `{data: [{embedding: [number, ...]}, ...]}`.
 * Error messages are wrapped so the CLI doesn't have to interpret raw
 * fetch / Response failures.
 */

export const DEFAULT_EMBED_BASE_URL = "http://localhost:11434/v1";
export const DEFAULT_EMBED_MODEL = "nomic-embed-text";

export class EmbeddingError extends Error {}

export interface EmbeddingClientOptions {
  baseUrl?: string;
  model?: string;
  apiKey?: string;
  /** Wall-clock cap for a single batch. Defaults to 30s. */
  timeoutMs?: number;
}

export interface EmbeddingClient {
  embedBatch(texts: string[]): Promise<number[][]>;
  readonly model: string;
  readonly baseUrl: string;
}

/**
 * Build a client. Stateless; reuse one instance across an indexing
 * run so the underlying TCP connection can be reused (Node's fetch
 * does this automatically when the URL stays constant).
 */
export function createEmbeddingClient(
  opts: EmbeddingClientOptions = {},
): EmbeddingClient {
  const baseUrl = (opts.baseUrl ?? DEFAULT_EMBED_BASE_URL).replace(/\/+$/, "");
  const model = opts.model ?? DEFAULT_EMBED_MODEL;
  const apiKey = opts.apiKey;
  const timeoutMs = opts.timeoutMs ?? 30_000;

  return {
    model,
    baseUrl,
    async embedBatch(texts) {
      // Empty input fast-path: callers walking files often want this
      // so they don't special-case "no candidate files".
      if (texts.length === 0) return [];

      const url = `${baseUrl}/embeddings`;
      const headers: Record<string, string> = {
        "content-type": "application/json",
      };
      if (apiKey) headers.authorization = `Bearer ${apiKey}`;

      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), timeoutMs);
      let resp: Response;
      try {
        resp = await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify({ model, input: texts }),
          signal: ac.signal,
        });
      } catch (err) {
        clearTimeout(timer);
        const cause = err as Error;
        throw new EmbeddingError(
          `embeddings endpoint unreachable at ${url}: ${cause.message}`,
        );
      } finally {
        clearTimeout(timer);
      }
      if (!resp.ok) {
        const text = await resp.text().catch(() => "<no body>");
        throw new EmbeddingError(
          `embeddings endpoint returned HTTP ${resp.status}: ${text.slice(0, 200)}`,
        );
      }
      let payload: unknown;
      try {
        payload = await resp.json();
      } catch (err) {
        throw new EmbeddingError(
          `embeddings response was not JSON: ${(err as Error).message}`,
        );
      }
      const data = (payload as { data?: unknown }).data;
      if (!Array.isArray(data)) {
        throw new EmbeddingError(
          `embeddings response missing 'data' array: ${JSON.stringify(payload).slice(0, 200)}`,
        );
      }
      const out: number[][] = [];
      for (let i = 0; i < data.length; i++) {
        const row = data[i];
        const emb =
          row && typeof row === "object" && "embedding" in row
            ? (row as { embedding: unknown }).embedding
            : undefined;
        if (!Array.isArray(emb)) {
          throw new EmbeddingError(
            `embeddings response row ${i} missing 'embedding' list`,
          );
        }
        out.push(emb.map((x) => Number(x)));
      }
      if (out.length !== texts.length) {
        throw new EmbeddingError(
          `embeddings response returned ${out.length} vectors for ${texts.length} inputs — server bug, refusing to align`,
        );
      }
      return out;
    },
  };
}

/** Build the default client from env vars. Used by the CLI. */
export function defaultEmbeddingClient(): EmbeddingClient {
  return createEmbeddingClient({
    baseUrl: process.env.CLAW_SQUAD_EMBED_BASE_URL,
    model: process.env.CLAW_SQUAD_EMBED_MODEL,
    apiKey: process.env.CLAW_SQUAD_EMBED_API_KEY || undefined,
  });
}
