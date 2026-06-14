import { http } from './client';

export interface RequestConfig {
  url: string;
  method?: string;
  data?: unknown;
  params?: Record<string, unknown>;
}

// Generic wrapper: the URL arrives as a *property* of the config object and the real
// HTTP call reads it off `cfg.url`. Full chain: page → hook → thunk/api → request → http.request.
export async function request<T>(cfg: RequestConfig): Promise<T> {
  const res = await http.request({ url: cfg.url, method: cfg.method, data: cfg.data, params: cfg.params });
  return res.data as T;
}
