import { createSlice, createAsyncThunk } from '@reduxjs/toolkit';
import { createOrder } from '../api/orderApi';

// Redux thunk flow: CheckoutPage → useCheckout → placeOrder (thunk) → createOrder → request → http.
export const placeOrder = createAsyncThunk(
  'order/placeOrder',
  async (payload: { sku: string; qty: number }) => {
    return await createOrder(payload);
  },
);

interface OrderState {
  lastId: string | null;
}

const orderSlice = createSlice({
  name: 'order',
  initialState: { lastId: null } as OrderState,
  reducers: {},
  extraReducers: (builder) => {
    builder.addCase(placeOrder.fulfilled, (state, action) => {
      state.lastId = action.payload.id;
    });
  },
});

export default orderSlice.reducer;
