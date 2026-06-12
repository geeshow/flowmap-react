import { http } from './client';

// POST /orders → ambiguous (order-service AND sample-shop both expose it).
export async function createOrder(payload: unknown) {
  const res = await http.post('/orders', payload);
  return res.data;
}

// POST /orders/{}/notify → matches sample-shop.
export async function notifyOrder(id: string) {
  await http.post(`/orders/${id}/notify`, {});
}
