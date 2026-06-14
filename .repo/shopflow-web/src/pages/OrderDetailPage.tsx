import React, { useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { useOrderDetail } from '../hooks/useOrders';

export default function OrderDetailPage() {
  const { id = '1' } = useParams();
  const { order, load } = useOrderDetail(id);
  useEffect(() => {
    load();
  }, [id]);
  return <div>{order?.id}</div>;
}
