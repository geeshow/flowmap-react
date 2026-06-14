import React from 'react';
import { useAddWishlist } from '../hooks/useWishlist';

// Leaf component (POST). Reached from the screen via render edges: Page → Panel → Button.
export default function WishlistButton({ userId }: { userId: number }) {
  const { add } = useAddWishlist();
  return <button onClick={() => add(userId, 'SKU-9')}>Add to wishlist</button>;
}
