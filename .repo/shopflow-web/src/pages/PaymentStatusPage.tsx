import React, { useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { usePaymentStatus } from '../hooks/usePaymentStatus';

export default function PaymentStatusPage() {
  const { id = '1' } = useParams();
  const { status, load } = usePaymentStatus(id);
  useEffect(() => {
    load();
  }, [id]);
  return <div>{status}</div>;
}
