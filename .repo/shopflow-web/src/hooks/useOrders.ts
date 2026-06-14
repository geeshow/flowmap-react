import { useState } from 'react';
import { listOrders, getOrder } from '../api/orderApi';

// Plain hook: OrderListPage → useOrders → listOrders → request → http.
export function useOrders() {
  const [orders, setOrders] = useState<Array<{ id: string }>>([]);
  async function load() {
    setOrders(await listOrders());
  }
  return { orders, load };
}

// Plain hook: OrderDetailPage → useOrderDetail → getOrder → request → http.
export function useOrderDetail(id: string) {
  const [order, setOrder] = useState<{ id: string } | null>(null);
  async function load() {
    setOrder(await getOrder(id));
  }
  return { order, load };
}
