import { createSlice, createAsyncThunk, PayloadAction } from '@reduxjs/toolkit';
import { getUser } from '../api/user';

export const fetchUser = createAsyncThunk('user/fetchUser', async (id: string) => {
  return await getUser(id);
});

interface UserState {
  current: { id: string; name: string } | null;
}

const userSlice = createSlice({
  name: 'user',
  initialState: { current: null } as UserState,
  reducers: {
    setUser(state, action: PayloadAction<UserState['current']>) {
      state.current = action.payload;
    },
    clearUser(state) {
      state.current = null;
    },
  },
});

export const { setUser, clearUser } = userSlice.actions;
export default userSlice.reducer;
