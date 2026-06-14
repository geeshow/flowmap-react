import React from 'react';
import { useWriteReview } from '../hooks/useWriteReview';

export default function WriteReviewPage() {
  const { submit } = useWriteReview();
  return <button onClick={() => submit(1, 7, 'nice')}>Submit review</button>;
}
