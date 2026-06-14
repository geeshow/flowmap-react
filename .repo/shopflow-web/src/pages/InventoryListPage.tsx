import React, { useEffect } from 'react';
import { useInventory } from '../hooks/useInventory';

export default function InventoryListPage() {
  const { rows, load } = useInventory();
  useEffect(() => {
    load();
  }, []);
  return <ul>{rows.map((r) => <li key={r.sku}>{r.sku}</li>)}</ul>;
}
