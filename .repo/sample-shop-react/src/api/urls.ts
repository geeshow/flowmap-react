// Niffler-style URL table: nested template literals over a const base, exposed as
// object members (`NIFFLER_API_URL.ACCOUNT_OPENABLE`). Exercises member-access +
// nested-template constant folding in the ConstantEvaluator.
const API_GW = 'https://api.shop.com';

export const NIFFLER_BASE_URL = `${API_GW}/account` as const;

export const NIFFLER_API_URL = {
  ACCOUNT_OPENABLE: `${NIFFLER_BASE_URL}/v1/account-openable`,
  ACCOUNT_LIST: `${NIFFLER_BASE_URL}/v1/account-list`,
  SERVICE_TERMS: `${NIFFLER_BASE_URL}/v1/service-terms`,
} as const;
