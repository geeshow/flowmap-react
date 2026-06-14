import React, { useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { useItemReviews } from '../hooks/useItemReviews';

export default function ItemReviewsPage() {
  const { id = '' } = useParams();
  const { reviews, load } = useItemReviews(id);
  useEffect(() => {
    load();
  }, [id]);
  return <ul>{reviews.map((r) => <li key={r.id}>{r.reviewer}</li>)}</ul>;
}
