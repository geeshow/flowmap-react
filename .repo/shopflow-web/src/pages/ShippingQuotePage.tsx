import React from 'react';
import { useShippingQuote } from '../hooks/useShippingQuote';

export default function ShippingQuotePage() {
  const { getQuote } = useShippingQuote();
  return <button onClick={() => getQuote(1)}>Get shipping quote</button>;
}
