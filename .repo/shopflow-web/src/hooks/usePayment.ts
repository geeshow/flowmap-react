import { useDispatch } from 'react-redux';
import { submitPayment } from '../store/paymentSlice';

// Hook that dispatches the redux thunk (PaymentPage → usePayment → submitPayment thunk).
export function usePayment() {
  const dispatch = useDispatch<any>();
  function pay(orderId: string, amount: number) {
    return dispatch(submitPayment({ orderId, amount }));
  }
  return { pay };
}
