import { request } from './request';
import { API_ROUTES, gwWishlistByUser } from './routes';

// GET /wishlist/v1/wishlist/{}
export async function getWishlist(userId: string) {
  const url = gwWishlistByUser(userId);
  return request<Array<{ sku: string }>>({ url, method: 'GET' });
}

// POST /wishlist/v1/wishlist
export async function addWishlist(body: { userId: number; sku: string }) {
  return request<{ sku: string }>({ url: API_ROUTES.wishlist.create, method: 'POST', data: body });
}
