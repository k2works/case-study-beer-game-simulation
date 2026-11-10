import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
import { useNavigate } from 'react-router';
import { ApiError, type ApiClient } from './api/types.js';

export const ApiContext = createContext<ApiClient | null>(null);
export const PollContext = createContext<number>(5000);

export function useApi(): ApiClient {
  const api = useContext(ApiContext);
  if (!api) throw new Error('ApiContext がありません');
  return api;
}

/**
 * 画面の状態を取得し、変化の通知（SSE）と一定間隔のポーリングで追いつく。
 * 資格が無い（401）場合は、参加の画面へ誘導する。
 */
export function useLiveSnapshot<T>(
  gameId: string,
  load: () => Promise<T>,
): { data: T | null; error: string | null; reload: () => Promise<void> } {
  const api = useApi();
  const pollMs = useContext(PollContext);
  const navigate = useNavigate();
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const loadRef = useRef(load);
  loadRef.current = load;

  const reload = useCallback(async () => {
    try {
      setData(await loadRef.current());
      setError(null);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        navigate('/join', { state: { message: e.message } });
        return;
      }
      setError(e instanceof Error ? e.message : '読み込めませんでした');
    }
  }, [navigate]);

  useEffect(() => {
    void reload();
    const off = api.subscribe(gameId, () => void reload());
    const timer = pollMs > 0 ? setInterval(() => void reload(), pollMs) : null;
    return () => {
      off();
      if (timer) clearInterval(timer);
    };
  }, [api, gameId, pollMs, reload]);

  return { data, error, reload };
}
