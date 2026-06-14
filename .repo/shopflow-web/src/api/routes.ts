// URL const tables. Nothing here is an inline literal at the call site: every API
// URL is composed from `GW_BASE` (env) + a `SVC` service segment + a per-service
// path const, via template literals. Some path entries are functions `(id) => ...`
// that fold a path param to `{}`.
import { GW_BASE } from './env';

export const SVC = {
  ORDER: 'order',
  USER: 'user',
  PAYMENT: 'payment',
  CATALOG: 'catalog',
  REVIEW: 'review',
  SHIPPING: 'shipping',
  INVENTORY: 'inventory',
  WISHLIST: 'wishlist',
} as const;

export const USER_PATHS = {
  CREATE: '/v1/users',
  PROFILE: (id: string) => `/v1/users/${id}/profile`,
} as const;

export const ORDER_PATHS = {
  CREATE: '/v1/orders',
  LIST: '/v1/orders',
  DETAIL: (id: string) => `/v1/orders/${id}`,
} as const;

export const PAYMENT_PATHS = {
  CREATE: '/v1/payments',
  STATUS: (id: string) => `/v1/payments/${id}`,
} as const;

export const CATALOG_PATHS = {
  ITEMS: '/v1/catalog/items',
  ITEM: (id: string) => `/v1/catalog/items/${id}`,
} as const;

export const REVIEW_PATHS = {
  CREATE: '/v1/reviews',
  BY_ITEM: (itemId: string) => `/v1/reviews/item/${itemId}`,
} as const;

export const SHIPPING_PATHS = {
  QUOTE: '/v1/shipping/quote',
  TRACK: (orderId: string) => `/v1/shipping/order/${orderId}/track`,
} as const;

// Relative paths — used with a dedicated axios instance whose baseURL already embeds
// the gateway segment (`${GW_BASE}/${SVC.INVENTORY}`). Exercises baseURL composition.
export const INVENTORY_PATHS = {
  LIST: '/v1/inventory',
  BY_SKU: (sku: string) => `/v1/inventory/${sku}`,
} as const;

// baseURL for the inventory axios instance: env base + gateway service segment.
export const INVENTORY_BASE_URL = `${GW_BASE}/${SVC.INVENTORY}`;

// Direct (non-gateway) backend paths — called against API_BASE so the normalized
// endpoint equals the backend controller path exactly (join Stage-1 direct match).
export const SEARCH_PATHS = {
  QUERY: '/v1/search',
} as const;

export const WISHLIST_PATHS = {
  CREATE: '/v1/wishlist',
  BY_USER: (userId: string) => `/v1/wishlist/${userId}`,
} as const;

// Composed gateway routes — `${GW_BASE}/${SVC.X}${PATH}` template literals.
export const API_ROUTES = {
  user: {
    create: `${GW_BASE}/${SVC.USER}${USER_PATHS.CREATE}`,
  },
  order: {
    create: `${GW_BASE}/${SVC.ORDER}${ORDER_PATHS.CREATE}`,
    list: `${GW_BASE}/${SVC.ORDER}${ORDER_PATHS.LIST}`,
  },
  payment: {
    create: `${GW_BASE}/${SVC.PAYMENT}${PAYMENT_PATHS.CREATE}`,
  },
  catalog: {
    items: `${GW_BASE}/${SVC.CATALOG}${CATALOG_PATHS.ITEMS}`,
  },
  review: {
    create: `${GW_BASE}/${SVC.REVIEW}${REVIEW_PATHS.CREATE}`,
  },
  shipping: {
    quote: `${GW_BASE}/${SVC.SHIPPING}${SHIPPING_PATHS.QUOTE}`,
  },
  wishlist: {
    create: `${GW_BASE}/${SVC.WISHLIST}${WISHLIST_PATHS.CREATE}`,
  },
} as const;

// Per-{id} gateway routes — compose env base + service segment + function-valued path const.
export const gwUserProfile = (id: string) => `${GW_BASE}/${SVC.USER}${USER_PATHS.PROFILE(id)}`;
export const gwOrderDetail = (id: string) => `${GW_BASE}/${SVC.ORDER}${ORDER_PATHS.DETAIL(id)}`;
export const gwPaymentStatus = (id: string) => `${GW_BASE}/${SVC.PAYMENT}${PAYMENT_PATHS.STATUS(id)}`;
export const gwCatalogItem = (id: string) => `${GW_BASE}/${SVC.CATALOG}${CATALOG_PATHS.ITEM(id)}`;
export const gwReviewByItem = (itemId: string) => `${GW_BASE}/${SVC.REVIEW}${REVIEW_PATHS.BY_ITEM(itemId)}`;
export const gwShippingTrack = (orderId: string) => `${GW_BASE}/${SVC.SHIPPING}${SHIPPING_PATHS.TRACK(orderId)}`;
export const gwWishlistByUser = (userId: string) => `${GW_BASE}/${SVC.WISHLIST}${WISHLIST_PATHS.BY_USER(userId)}`;
