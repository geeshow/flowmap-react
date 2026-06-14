import { request } from './request';
import { API_ROUTES, gwUserProfile } from './routes';

// POST /user/v1/users — URL from the pre-composed API_ROUTES table.
export async function createUser(payload: { email: string; name: string }) {
  return request<{ id: string }>({ url: API_ROUTES.user.create, method: 'POST', data: payload });
}

// GET /user/v1/users/{}/profile — URL from a function-valued path const composed with the service segment.
export async function getProfile(id: string) {
  const url = gwUserProfile(id);
  return request<{ id: string; name: string }>({ url, method: 'GET' });
}
