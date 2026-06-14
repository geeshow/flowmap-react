import React from 'react';
import { createBrowserRouter } from 'react-router-dom';
import SignupPage from './pages/SignupPage';
import ProfilePage from './pages/ProfilePage';
import CheckoutPage from './pages/CheckoutPage';
import OrderListPage from './pages/OrderListPage';
import OrderDetailPage from './pages/OrderDetailPage';
import PaymentPage from './pages/PaymentPage';
import PaymentStatusPage from './pages/PaymentStatusPage';
import CatalogPage from './pages/CatalogPage';
import ItemDetailPage from './pages/ItemDetailPage';
import ItemReviewsPage from './pages/ItemReviewsPage';
import WriteReviewPage from './pages/WriteReviewPage';
import ShippingQuotePage from './pages/ShippingQuotePage';
import TrackShipmentPage from './pages/TrackShipmentPage';
import InventoryListPage from './pages/InventoryListPage';
import InventoryDetailPage from './pages/InventoryDetailPage';
import SearchPage from './pages/SearchPage';
import WishlistPage from './pages/WishlistPage';

export const router = createBrowserRouter([
  { path: '/signup', element: <SignupPage /> },
  { path: '/profile', element: <ProfilePage /> },
  { path: '/checkout', element: <CheckoutPage /> },
  { path: '/orders', element: <OrderListPage /> },
  { path: '/orders/:id', element: <OrderDetailPage /> },
  { path: '/payment', element: <PaymentPage /> },
  { path: '/payment/:id', element: <PaymentStatusPage /> },
  { path: '/catalog', element: <CatalogPage /> },
  { path: '/catalog/:id', element: <ItemDetailPage /> },
  { path: '/items/:id/reviews', element: <ItemReviewsPage /> },
  { path: '/reviews/new', element: <WriteReviewPage /> },
  { path: '/shipping/quote', element: <ShippingQuotePage /> },
  { path: '/shipping/:id/track', element: <TrackShipmentPage /> },
  { path: '/inventory', element: <InventoryListPage /> },
  { path: '/inventory/:sku', element: <InventoryDetailPage /> },
  { path: '/search', element: <SearchPage /> },
  { path: '/wishlist/:userId', element: <WishlistPage /> },
]);
