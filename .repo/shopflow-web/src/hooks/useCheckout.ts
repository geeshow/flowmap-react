import { useDispatch } from 'react-redux';
import { placeOrder } from '../store/orderSlice';

// Hook that dispatches the redux thunk (CheckoutPage → useCheckout → placeOrder thunk).
export function useCheckout() {
  const dispatch = useDispatch<any>();
  function checkout(sku: string, qty: number) {
    return dispatch(placeOrder({ sku, qty }));
  }
  return { checkout };
}
