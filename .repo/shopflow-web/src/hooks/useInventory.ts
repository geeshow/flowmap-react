import { useState } from 'react';
import { listStock, getStock } from '../api/inventoryApi';

export function useInventory() {
  const [rows, setRows] = useState<Array<{ sku: string }>>([]);
  async function load() {
    setRows(await listStock());
  }
  return { rows, load };
}

export function useStockDetail(sku: string) {
  const [stock, setStock] = useState<{ sku: string; onHand: number } | null>(null);
  async function load() {
    setStock(await getStock(sku));
  }
  return { stock, load };
}
