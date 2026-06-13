import queryString from 'query-string';
import { queryOptions, useQuery, useSuspenseQuery } from '@tanstack/react-query';
import accountAxios from '../lib/accountAxios';
import { NIFFLER_API_URL } from './urls';

export const ACCOUNT_LIST_QUERY_KEY = 'account-list';

type AccountListParams = {
  queryType?: string;
  accountKey?: string;
  accountOpenKey?: string;
};

// React Query options factory: URL is built by `queryString.stringifyUrl({ url, query })`
// into a local const, then used by `accountAxios.get(url)` inside the queryFn.
// Resolves to GET https://api.shop.com/account/v1/account-list.
export const accountListQueryOptions = <T = unknown>({
  queryType = 'NORMAL',
  accountKey,
  accountOpenKey,
}: AccountListParams) => {
  const url = queryString.stringifyUrl({
    url: NIFFLER_API_URL.ACCOUNT_LIST,
    query: {
      query_type: queryType,
      ...(accountKey && { account_key: accountKey }),
      ...(accountOpenKey && { account_open_key: accountOpenKey }),
    },
  });

  return queryOptions({
    queryKey: [ACCOUNT_LIST_QUERY_KEY, url],
    queryFn: ({ signal }: { signal: any }) => accountAxios.get(url, { signal }),
  });
};

export const useAccountListQuery = <T = unknown>(params: AccountListParams) => {
  return useQuery({ ...accountListQueryOptions<T>(params) });
};

export const useAccountListSuspenseQuery = <T = unknown>(params: AccountListParams) => {
  return useSuspenseQuery({ ...accountListQueryOptions<T>(params) });
};
