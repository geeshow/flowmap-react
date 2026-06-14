import React from 'react';
import { useParams } from 'react-router-dom';
import WishlistPanel from '../components/WishlistPanel';

// SCREEN reaches both wishlist APIs via the render chain Page → Panel → Button.
export default function WishlistPage() {
  const { userId = '' } = useParams();
  return <WishlistPanel userId={userId} />;
}
