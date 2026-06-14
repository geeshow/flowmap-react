import { request } from './request';
import { API_ROUTES, gwPaymentStatus } from './routes';

// POST /payment/v1/payments — URL from the pre-composed API_ROUTES table.
export async function createPayment(payload: { orderId: string; amount: number }) {
  return request<{ id: string }>({ url: API_ROUTES.payment.create, method: 'POST', data: payload });
}

// GET /payment/v1/payments/{} — URL from a function-valued path const.
export async function getPaymentStatus(id: string) {
  const url = gwPaymentStatus(id);
  return request<{ id: string; status: string }>({ url, method: 'GET' });
}
