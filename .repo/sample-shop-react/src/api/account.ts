import { http } from './client';
import { fetchData } from './fetchData';
import { NIFFLER_API_URL } from './urls';

export type FetchAccountOpenableParams = { guideCode: string };

// Level-1 wrapper: forwards to the generic `fetchData` wrapper with the URL as a
// config-object property. Full chain: component → fetchAccountOpenable → fetchData → http.get.
// Resolves to GET https://api.shop.com/account/v1/account-openable.
export async function fetchAccountOpenable({ guideCode }: FetchAccountOpenableParams) {
  return fetchData<{ partnerId: string }>({
    url: NIFFLER_API_URL.ACCOUNT_OPENABLE,
    query: { guideCode },
  });
}

// Local object destructure: the URL is pulled off a config object via `const { url } = config`
// before the HTTP call. Resolves to GET https://api.shop.com/account/v1/service-terms.
export async function fetchServiceTerms() {
  const config = { url: NIFFLER_API_URL.SERVICE_TERMS, query: {} };
  const { url } = config;
  const res = await http.get(url);
  return res.data;
}
