import { useReviewLoader } from './useReviewLoader';

// Outer hook wraps the inner loader hook — extra layer of indirection before the API.
export function useItemReviews(itemId: string) {
  const loader = useReviewLoader(itemId);
  return { reviews: loader.data, load: loader.run };
}
