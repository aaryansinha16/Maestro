// Thin fetch wrapper for the conductor API. The dev server proxies /api to
// the conductor (see vite.config.ts), so a same-origin fetch works in dev and
// in production when both are served from one Hono app.

import { useMemo } from 'react'

interface ApiClient {
  get<T>(path: string, init?: RequestInit): Promise<T>
  post<T>(path: string, body?: unknown, init?: RequestInit): Promise<T>
}

export function useApi(): ApiClient {
  return useMemo(() => {
    const base = import.meta.env.VITE_API_BASE_URL ?? ''

    async function request<T>(path: string, init: RequestInit): Promise<T> {
      const res = await fetch(`${base}${path}`, {
        ...init,
        headers: {
          'content-type': 'application/json',
          ...(init.headers ?? {}),
        },
      })
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new Error(`API ${res.status} ${res.statusText}: ${text}`)
      }
      return (await res.json()) as T
    }

    return {
      get: (path, init) => request(path, { method: 'GET', ...(init ?? {}) }),
      post: (path, body, init) =>
        request(path, {
          method: 'POST',
          body: body ? JSON.stringify(body) : undefined,
          ...(init ?? {}),
        }),
    }
  }, [])
}
