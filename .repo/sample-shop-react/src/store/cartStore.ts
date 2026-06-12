import { create } from 'zustand';

interface CartState {
  items: string[];
  add: (sku: string) => void;
  clear: () => void;
}

export const useCartStore = create<CartState>((set) => ({
  items: [],
  add: (sku) => set((s) => ({ items: [...s.items, sku] })),
  clear: () => set({ items: [] }),
}));
