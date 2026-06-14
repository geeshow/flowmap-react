import { createSlice, createAsyncThunk } from '@reduxjs/toolkit';
import { quoteShipping } from '../api/shippingApi';

// Redux thunk flow: ShippingQuotePage → useShippingQuote → requestQuote (thunk) → quoteShipping → request → http.
export const requestQuote = createAsyncThunk(
  'shipping/requestQuote',
  async (payload: { orderId: number }) => {
    return await quoteShipping(payload);
  },
);

interface ShippingState {
  cost: number | null;
}

const shippingSlice = createSlice({
  name: 'shipping',
  initialState: { cost: null } as ShippingState,
  reducers: {},
  extraReducers: (builder) => {
    builder.addCase(requestQuote.fulfilled, (state, action) => {
      state.cost = action.payload.cost;
    });
  },
});

export default shippingSlice.reducer;
