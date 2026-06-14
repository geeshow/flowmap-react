import { configureStore } from '@reduxjs/toolkit';
import orderReducer from './orderSlice';
import paymentReducer from './paymentSlice';
import shippingReducer from './shippingSlice';

export const store = configureStore({
  reducer: {
    order: orderReducer,
    payment: paymentReducer,
    shipping: shippingReducer,
  },
});

export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;
