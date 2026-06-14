import React, { useEffect } from 'react';
import { useWishlist } from '../hooks/useWishlist';
import WishlistButton from './WishlistButton';

// Mid component (GET) that also renders the leaf button — deepens the render chain.
export default function WishlistPanel({ userId }: { userId: string }) {
  const { items, load } = useWishlist(userId);
  useEffect(() => {
    load();
  }, [userId]);
  return (
    <div>
      <ul>{items.map((i) => <li key={i.sku}>{i.sku}</li>)}</ul>
      <WishlistButton userId={Number(userId)} />
    </div>
  );
}
