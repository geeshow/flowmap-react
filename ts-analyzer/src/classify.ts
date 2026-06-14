/**
 * Editable signature tables — the analog of the backend's Classify.kt
 * (LAYER_ANNOTATIONS / EXTERNAL_PREFIXES). Detection is by import source string
 * and call shape, NOT by resolved library types, so the analyzer runs against a
 * checkout whose node_modules aren't installed.
 */

/** Module specifiers whose default/`axios` export is an HTTP client. */
export const AXIOS_MODULES = new Set(['axios']);

/** SWR read-hook modules — `useSWR(key, fetcher)` treats `key` as the GET URL. */
export const SWR_QUERY_MODULES = new Set(['swr', 'swr/immutable', 'swr/infinite']);

/** Other HTTP clients with the same `client.verb(url)` / `client(url, {method})` shape. */
export const HTTP_CLIENT_MODULES = new Set(['ky', 'got', 'superagent']);

/** HTTP verbs available as axios instance methods. */
export const AXIOS_VERB_METHODS = new Set(['get', 'post', 'put', 'delete', 'patch', 'head', 'options']);

/** Generic request methods that take a config object with { method, url }. */
export const AXIOS_REQUEST_METHODS = new Set(['request']);

/** react-router route container / definition identifiers. */
export const ROUTER_ROUTE_TAGS = new Set(['Route']);
export const ROUTER_FACTORY_FNS = new Set(['createBrowserRouter', 'createHashRouter', 'createMemoryRouter', 'useRoutes']);

/** Redux Toolkit / Zustand / Context factory identifiers. */
export const REDUX_SLICE_FN = 'createSlice';
export const REDUX_ASYNC_THUNK_FN = 'createAsyncThunk';
export const ZUSTAND_CREATE_FNS = new Set(['create', 'createStore']);
export const CONTEXT_CREATE_FN = 'createContext';

/** Redux store hooks. */
export const REDUX_HOOKS = new Set(['useSelector', 'useDispatch', 'useStore']);

/** Files that are NOT routable Next.js screens. */
export const NEXT_NON_SCREEN = new Set(['_app', '_document', '_error', 'middleware']);

/** Directories to skip while discovering source files. Mirrors backend skipDirs. */
export const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.next', '.git', 'coverage', 'out', '.turbo']);

export const SOURCE_EXTENSIONS = ['.tsx', '.ts', '.jsx', '.js', '.mjs', '.cjs'];

/** A custom hook by React convention: `use` + UpperCase. */
export function isHookName(name: string): boolean {
  return /^use[A-Z0-9]/.test(name);
}

/** A React component by convention: PascalCase. */
export function isComponentName(name: string): boolean {
  return /^[A-Z]/.test(name);
}
