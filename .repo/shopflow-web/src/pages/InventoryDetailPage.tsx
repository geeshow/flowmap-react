import React, { useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { useStockDetail } from '../hooks/useInventory';

export default function InventoryDetailPage() {
  const { sku = '' } = useParams();
  const { stock, load } = useStockDetail(sku);
  useEffect(() => {
    load();
  }, [sku]);
  return <div>{stock?.onHand}</div>;
}
