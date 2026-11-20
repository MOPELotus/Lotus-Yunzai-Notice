export type PublicMysTransport = (url: URL, init: RequestInit) => Promise<Response>;

interface PublicRequest {
  readonly url: URL;
  readonly alternate?: URL;
  readonly signal: AbortSignal;
  readonly phaseMs?: number;
  readonly accept?: string;
}

function discard(response: Response) {
  void response.body?.cancel().catch(() => undefined);
}

export async function readPublicMys<T>({ url, alternate, signal, phaseMs, accept }: PublicRequest,
  transport: PublicMysTransport, decode: (response: Response) => Promise<T>): Promise<T> {
  const addresses = alternate ? [url, alternate] : [url];
  for (const [index, address] of addresses.entries()) {
    signal.throwIfAborted();
    const another = index + 1 < addresses.length;
    const active = phaseMs ? AbortSignal.any([signal, AbortSignal.timeout(phaseMs)]) : signal;
    let response: Response;
    try {
      response = await transport(address, {
        method: "GET", redirect: "manual", credentials: "omit", signal: active,
        headers: { Referer: "https://www.miyoushe.com/", ...(accept && { Accept: accept, "User-Agent": "Mozilla/5.0" }) },
      });
    } catch (error) {
      signal.throwIfAborted();
      if (another) continue;
      throw error;
    }

    if (signal.aborted) {
      discard(response);
      signal.throwIfAborted();
    }
    if (!response.ok && (response.status < 500 || !another)) return decode(response);
    if (active.aborted || !response.ok) {
      discard(response);
      if (another) continue;
      active.throwIfAborted();
    }

    try {
      const value = await decode(response);
      active.throwIfAborted();
      return value;
    } catch (error) {
      signal.throwIfAborted();
      // JSON and media validation failures are terminal. An interrupted body can try the alternate.
      if (another && (active.aborted || error instanceof TypeError)) {
        discard(response);
        continue;
      }
      throw error;
    }
  }
  throw new Error("米游社公开接口不可用。");
}
