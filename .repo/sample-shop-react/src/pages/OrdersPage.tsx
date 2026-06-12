import React from 'react';
import { createOrder, notifyOrder } from '../api/order';
import { getInvestmentSummary } from '../api/investment';
import { geocode } from '../api/maps';
import { useCartStore } from '../store/cartStore';

export default function OrdersPage() {
  const add = useCartStore((s) => s.add); // store:read zustand

  async function submit() {
    await createOrder({ sku: 'A1' }); // api POST /orders (ambiguous)
    await notifyOrder('42'); // api POST /orders/{}/notify
    await getInvestmentSummary(); // api GET /internal/investment/current-summary
    await geocode('Seoul'); // EXTERNAL third-party
    await fetch('/orders'); // bare fetch → GET /orders, partial verb
  }

  return (
    <button onClick={submit} onMouseEnter={() => add('A1')}>
      Order
    </button>
  );
}
