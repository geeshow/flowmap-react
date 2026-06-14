import { useState } from 'react';
import { listItems, getItem } from '../api/catalogApi';

// Plain hook: CatalogPage → useCatalog → listItems → request → http.
export function useCatalog() {
  const [items, setItems] = useState<Array<{ id: string }>>([]);
  async function load() {
    setItems(await listItems());
  }
  return { items, load };
}

// Plain hook: ItemDetailPage → useItemDetail → getItem → request → http.
export function useItemDetail(id: string) {
  const [item, setItem] = useState<{ id: string; name: string } | null>(null);
  async function load() {
    setItem(await getItem(id));
  }
  return { item, load };
}
