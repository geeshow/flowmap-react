import { useDispatch } from 'react-redux';
import { requestQuote } from '../store/shippingSlice';

// Dispatches the redux thunk (ShippingQuotePage → useShippingQuote → requestQuote thunk).
export function useShippingQuote() {
  const dispatch = useDispatch<any>();
  function getQuote(orderId: number) {
    return dispatch(requestQuote({ orderId }));
  }
  return { getQuote };
}
