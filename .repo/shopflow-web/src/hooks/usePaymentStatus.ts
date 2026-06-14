import { useState } from 'react';
import { getPaymentStatus } from '../api/paymentApi';

// Plain hook: PaymentStatusPage → usePaymentStatus → getPaymentStatus → request → http.
export function usePaymentStatus(id: string) {
  const [status, setStatus] = useState('');
  async function load() {
    const p = await getPaymentStatus(id);
    setStatus(p.status);
  }
  return { status, load };
}
