import React, { lazy } from 'react';
import { createBrowserRouter } from 'react-router-dom';
import UserPage from './pages/UserPage';
import OrdersPage from './pages/OrdersPage';
import AccountPage from './pages/AccountPage';

// Lazy route → resolves the dynamic import's default export to a SCREEN.
const ReportPage = lazy(() => import('./pages/ReportPage'));

export const router = createBrowserRouter([
  { path: '/users/:id', element: <UserPage /> },
  { path: '/orders', element: <OrdersPage /> },
  { path: '/account', element: <AccountPage /> },
  { path: '/report', element: <ReportPage />, lazy: true },
]);
