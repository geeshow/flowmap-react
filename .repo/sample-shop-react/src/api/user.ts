import { http } from './client';

// Wrapper fn: component → getUser → http.get. Path has a template param → "{}".
// Resolves to GET https://api.shop.com/internal/users/{} → matches user-service.
export async function getUser(id: string) {
  const res = await http.get(`/internal/users/${id}`);
  return res.data;
}
