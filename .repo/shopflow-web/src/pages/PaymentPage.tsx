import React from 'react';
import { usePayment } from '../hooks/usePayment';

export default function PaymentPage() {
  const { pay } = usePayment();
  return <button onClick={() => pay('order-1', 1999)}>Pay</button>;
}
