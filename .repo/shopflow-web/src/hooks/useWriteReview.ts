import { createReview } from '../api/reviewApi';

// WriteReviewPage → useWriteReview → createReview → request → http.
export function useWriteReview() {
  async function submit(itemId: number, userId: number, text: string) {
    return createReview({ itemId, userId, text });
  }
  return { submit };
}
