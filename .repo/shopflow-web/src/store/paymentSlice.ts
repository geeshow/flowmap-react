import { createSlice, createAsyncThunk } from '@reduxjs/toolkit';
import { createPayment } from '../api/paymentApi';

// Redux thunk flow: PaymentPage → usePayment → submitPayment (thunk) → createPayment → request → http.
export const submitPayment = createAsyncThunk(
  'payment/submitPayment',
  async (payload: { orderId: string; amount: number }) => {
    return await createPayment(payload);
  },
);

interface PaymentState {
  lastId: string | null;
}

const paymentSlice = createSlice({
  name: 'payment',
  initialState: { lastId: null } as PaymentState,
  reducers: {},
  extraReducers: (builder) => {
    builder.addCase(submitPayment.fulfilled, (state, action) => {
      state.lastId = action.payload.id;
    });
  },
});

export default paymentSlice.reducer;
