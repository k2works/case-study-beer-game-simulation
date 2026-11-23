import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { ApiProvider } from '../api/ApiContext';
import type { ApiClient } from '../api/client';
import { AppRoutes } from '../App';

/** 画面を、URL（path）とフェイクの ApiClient で描画する。再取得の間隔は 0 にする。 */
export function renderApp(api: ApiClient, path: string) {
    return render(
        <MemoryRouter initialEntries={[path]}>
            <ApiProvider api={api} catchUp={{ attempts: 3, intervalMs: 0 }}>
                <AppRoutes />
            </ApiProvider>
        </MemoryRouter>,
    );
}
