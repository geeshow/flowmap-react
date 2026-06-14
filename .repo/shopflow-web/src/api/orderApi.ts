import { request } from './request';
import { GW_BASE } from './env';
import { API_ROUTES, SVC, ORDER_PATHS, gwOrderDetail } from './routes';

// POST /order/v1/orders — URL from the pre-composed API_ROUTES table.
export async function createOrder(payload: { sku: string; qty: number }) {
  return request<{ id: string }>({ url: API_ROUTES.order.create, method: 'POST', data: payload });
}

// GET /order/v1/orders — SUBSTITUTED-variable indirection: the path is pulled into a
// local const, then the URL is composed from env base + service segment + that var.
export async function listOrders() {
  const path = ORDER_PATHS.LIST;
  const url = `${GW_BASE}/${SVC.ORDER}${path}`;
  return request<Array<{ id: string }>>({ url, method: 'GET' });
}

// GET /order/v1/orders/{} — URL from a function-valued path const.
export async function getOrder(id: string) {
  const url = gwOrderDetail(id);
  return request<{ id: string }>({ url, method: 'GET' });
}
