import { request } from './request';
import { API_ROUTES, gwShippingTrack } from './routes';

// POST /shipping/v1/shipping/quote — URL from the pre-composed API_ROUTES table.
export async function quoteShipping(payload: { orderId: number }) {
  return request<{ orderId: number; cost: number }>({ url: API_ROUTES.shipping.quote, method: 'POST', data: payload });
}

// GET /shipping/v1/shipping/order/{}/track — URL from a function-valued path const composer.
export async function trackShipment(orderId: string) {
  const url = gwShippingTrack(orderId);
  return request<{ orderId: number; status: string }>({ url, method: 'GET' });
}
