import React from 'react';
import { useCheckout } from '../hooks/useCheckout';

export default function CheckoutPage() {
  const { checkout } = useCheckout();
  return <button onClick={() => checkout('SKU-1', 2)}>Checkout</button>;
}
