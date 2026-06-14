import { request } from './request';
import { API_ROUTES, gwReviewByItem } from './routes';

// GET /review/v1/reviews/item/{} — URL from a function-valued path const composer.
export async function listByItem(itemId: string) {
  const url = gwReviewByItem(itemId);
  return request<Array<{ id: string; reviewer: string }>>({ url, method: 'GET' });
}

// POST /review/v1/reviews — URL from the pre-composed API_ROUTES table.
export async function createReview(body: { itemId: number; userId: number; text: string }) {
  return request<{ id: string }>({ url: API_ROUTES.review.create, method: 'POST', data: body });
}
