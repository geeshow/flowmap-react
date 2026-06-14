import { useState } from 'react';
import { listByItem } from '../api/reviewApi';

// Inner hook in a hook→hook chain (depth): useItemReviews → useReviewLoader → listByItem → request → http.
export function useReviewLoader(itemId: string) {
  const [data, setData] = useState<Array<{ id: string; reviewer: string }>>([]);
  async function run() {
    setData(await listByItem(itemId));
  }
  return { data, run };
}
