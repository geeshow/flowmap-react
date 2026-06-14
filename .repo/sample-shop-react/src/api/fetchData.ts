import { http } from './client';

// Generic config-object wrapper (the `fetchData` pattern): the URL arrives as a
// *property* of the config object and the real HTTP call reads it off a destructured
// binding. Exercises config-object URL binding (not a positional parameter).
export async function fetchData<T>({ url, query }: { url: string; query?: Record<string, unknown> }): Promise<T> {
  const res = await http.get(url, { params: query });
  return res.data as T;
}
