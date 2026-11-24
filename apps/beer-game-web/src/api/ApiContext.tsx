import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { DEFAULT_CATCH_UP, type CatchUpOptions } from './catchUp';
import { createHttpApiClient, type ApiClient } from './client';

interface ApiContextValue {
    api: ApiClient;
    catchUp: CatchUpOptions;
}

const ApiContext = createContext<ApiContextValue | null>(null);

export function ApiProvider({
    api,
    catchUp = DEFAULT_CATCH_UP,
    children,
}: {
    api?: ApiClient;
    catchUp?: CatchUpOptions;
    children: ReactNode;
}) {
    const value = useMemo(() => ({ api: api ?? createHttpApiClient(), catchUp }), [api, catchUp]);
    return <ApiContext.Provider value={value}>{children}</ApiContext.Provider>;
}

function useApiContext(): ApiContextValue {
    const value = useContext(ApiContext);
    if (value === null) throw new Error('ApiProvider の外では使えません');
    return value;
}

export const useApi = (): ApiClient => useApiContext().api;
export const useCatchUp = (): CatchUpOptions => useApiContext().catchUp;
