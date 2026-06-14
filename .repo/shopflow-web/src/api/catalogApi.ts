import { request } from './request';
import { API_ROUTES, gwCatalogItem } from './routes';

// GET /catalog/v1/catalog/items — URL from the pre-composed API_ROUTES table.
export async function listItems() {
  return request<Array<{ id: string }>>({ url: API_ROUTES.catalog.items, method: 'GET' });
}

// GET /catalog/v1/catalog/items/{} — URL from a function-valued path const.
export async function getItem(id: string) {
  const url = gwCatalogItem(id);
  return request<{ id: string; name: string }>({ url, method: 'GET' });
}
