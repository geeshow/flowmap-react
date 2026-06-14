import axios from 'axios';
import { API_BASE } from './env';
import { SEARCH_PATHS } from './routes';

// Direct API instance (no gateway). Normalized endpoint = /v1/search, which matches
// shopflow-search's SearchController directly (join Stage-1, not gateway-prefix).
export const directHttp = axios.create({ baseURL: API_BASE, timeout: 5000 });

// GET https://api.shopflow.io/v1/search
export async function search(q: string) {
  const res = await directHttp.get<Array<{ id: number; title: string }>>(SEARCH_PATHS.QUERY, { params: { q } });
  return res.data;
}
