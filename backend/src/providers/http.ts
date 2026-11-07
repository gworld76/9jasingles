import { BadGatewayException, Logger } from '@nestjs/common';

const logger = new Logger('ExternalHttp');

/** Small fetch wrapper for provider APIs with a timeout and clean errors. */
export async function callJson<T>(url: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), init.timeoutMs ?? 15_000);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    const text = await res.text();
    const body = text ? JSON.parse(text) : {};
    if (!res.ok) {
      logger.warn(`${init.method ?? 'GET'} ${new URL(url).host} -> ${res.status}`);
      throw new BadGatewayException({ code: 'PROVIDER_ERROR', status: res.status });
    }
    return body as T;
  } finally {
    clearTimeout(timer);
  }
}
