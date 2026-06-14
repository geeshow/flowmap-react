import { useState } from 'react';
import { getWishlist, addWishlist } from '../api/wishlistApi';

export function useWishlist(userId: string) {
  const [items, setItems] = useState<Array<{ sku: string }>>([]);
  async function load() {
    setItems(await getWishlist(userId));
  }
  return { items, load };
}

export function useAddWishlist() {
  async function add(userId: number, sku: string) {
    return addWishlist({ userId, sku });
  }
  return { add };
}
