import React, { useEffect } from 'react';
import { useOrders } from '../hooks/useOrders';

export default function OrderListPage() {
  const { orders, load } = useOrders();
  useEffect(() => {
    load();
  }, []);
  return <ul>{orders.map((o) => <li key={o.id}>{o.id}</li>)}</ul>;
}
