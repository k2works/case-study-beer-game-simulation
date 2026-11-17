import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../../api/errors';
import type { DecisionEntry, Role, SessionState } from '../../api/types';
import { formatClock } from '../../labels';
import { expectNoStructuralA11yViolations } from '../../testing/a11y';
import { GAME_ID, fakeApi, gameState, roleStatus, versions } from '../../testing/fakeApi';
import { renderApp } from '../../testing/render';

type Overrides = Partial<SessionState> & { status?: SessionState['status'] };

function playerState(role: Role, overrides: Overrides = {}): SessionState {
    return {
        sessionId: GAME_ID,
        status: 'ACTIVE',
        week: 3,
        submittedRoleCount: 0,
        participantId: 'p-1',
        role,
        roleStatus: roleStatus({ inventory: 12, backlog: 4, arrivals: 6, orders: 8 }),
        versions: versions(5),
        ...overrides,
    };
}

const PATH = `/games/${GAME_ID}/play`;

describe('S05 プレイ', () => {
    it('第 N 週・役割・3 段階の週の進行・自分の役割の状況を示す', async () => {
        const api = fakeApi({
            getGameState: () =>
                Promise.resolve(gameState({ role: 'WHOLESALER', participantId: 'p-1' })),
            getSessionState: () => Promise.resolve(playerState('WHOLESALER')),
        });
        renderApp(api, PATH);

        expect(await screen.findByRole('heading', { name: 'プレイ' })).toBeInTheDocument();
        expect(screen.getByText(/^第 3 週\s+二次卸$/)).toBeInTheDocument();
        expect(screen.getByText(/2\. 入力/).closest('li')).toHaveAttribute('aria-current', 'step');
        expect(screen.getByText(/1\. 状況を確認/).closest('li')).not.toHaveAttribute(
            'aria-current',
        );
        expect(screen.getByText('在庫').nextSibling).toHaveTextContent('12');
        expect(screen.getByText('受注残').nextSibling).toHaveTextContent('4');
        expect(screen.getByText('入荷').nextSibling).toHaveTextContent('6');
        expect(screen.getByText('受注').nextSibling).toHaveTextContent('8');
        expect(screen.getByLabelText('発注数')).toBeInTheDocument();
        expect(screen.queryByText('顧客需要')).not.toBeInTheDocument();
    });

    it('工場の入力欄は「生産要請数」と呼ぶ', async () => {
        const api = fakeApi({
            getGameState: () => Promise.resolve(gameState({ role: 'FACTORY' })),
            getSessionState: () => Promise.resolve(playerState('FACTORY')),
        });
        renderApp(api, PATH);
        expect(await screen.findByLabelText('生産要請数')).toBeInTheDocument();
        expect(screen.queryByLabelText('発注数')).not.toBeInTheDocument();
    });

    it('小売店だけに、当週の顧客需要を示す', async () => {
        const api = fakeApi({
            getGameState: () => Promise.resolve(gameState({ role: 'RETAILER' })),
            getSessionState: () =>
                Promise.resolve(
                    playerState('RETAILER', {
                        roleStatus: roleStatus({ customerDemand: 8, orders: 8 }),
                    }),
                ),
        });
        renderApp(api, PATH);
        expect((await screen.findByText('顧客需要')).nextSibling).toHaveTextContent('8');
    });

    it('保存すると、意思決定の版を添えて送り、応答ではなく取得し直した状態から「現在の入力」を表示する', async () => {
        const user = userEvent.setup();
        let release: () => void = () => {};
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        let saved = false;
        const api = fakeApi({
            getGameState: () => Promise.resolve(gameState({ role: 'RETAILER' })),
            getSessionState: () =>
                Promise.resolve(
                    playerState('RETAILER', {
                        roleStatus: roleStatus({
                            decision: saved ? 10 : null,
                            decisionVersion: saved ? 1 : 0,
                        }),
                        versions: versions(saved ? 6 : 5),
                    }),
                ),
            saveDecision: async () => {
                await gate;
                saved = true;
                return { versions: versions(6) };
            },
        });
        renderApp(api, PATH);
        await user.type(await screen.findByLabelText('発注数'), '10');
        await user.click(screen.getByRole('button', { name: '発注を保存' }));

        // 保存の応答の前は、サーバーの結果を待ち、画面の値を書き換えない（楽観的な表示をしない）
        expect(screen.getByText('現在の入力: 未入力')).toBeInTheDocument();
        release();
        expect(await screen.findByText('現在の入力: 10')).toBeInTheDocument();
        // 保存した後は、進行役の確定を待つ段階になる
        expect(screen.getByText(/3\. 確定待ち/).closest('li')).toHaveAttribute(
            'aria-current',
            'step',
        );
        expect(api.saveDecision).toHaveBeenCalledWith(GAME_ID, { week: 3, quantity: 10 }, 0);
    });

    it('スナップショットが応答の versions に追いつくまで再取得し、追いつかなければ手動更新を促す', async () => {
        const user = userEvent.setup();
        const api = fakeApi({
            getGameState: () => Promise.resolve(gameState({ role: 'RETAILER' })),
            getSessionState: () =>
                Promise.resolve(playerState('RETAILER', { versions: versions(5) })),
            saveDecision: () => Promise.resolve({ versions: versions(6) }),
        });
        renderApp(api, PATH);
        await user.type(await screen.findByLabelText('発注数'), '10');
        await user.click(screen.getByRole('button', { name: '発注を保存' }));

        const status = await screen.findByText(
            '保存は完了しています。更新に時間がかかっています。「手動更新」を押してください。',
        );
        expect(status.closest('[aria-live]')).toHaveAttribute('aria-live', 'polite');
        // 初回の取得（1）＋追いつきの再取得（上限 3）
        expect(api.getSessionState.mock.calls.length).toBeGreaterThanOrEqual(1 + 3);
    });

    it.each([['abc'], ['1.5'], ['-1'], ['']])(
        '整数でない入力（%j）は、送らずに、入力欄の誤りとして示し、入力を保持する',
        async (typed) => {
            const user = userEvent.setup();
            const api = fakeApi({
                getGameState: () => Promise.resolve(gameState({ role: 'RETAILER' })),
                getSessionState: () => Promise.resolve(playerState('RETAILER')),
            });
            renderApp(api, PATH);
            const input = await screen.findByLabelText('発注数');
            if (typed !== '') await user.type(input, typed);
            await user.click(screen.getByRole('button', { name: '発注を保存' }));
            expect(
                await screen.findByText('発注数は 0〜1000 の整数で入力してください。'),
            ).toBeInTheDocument();
            expect(input).toHaveAttribute('aria-invalid', 'true');
            expect(input).toHaveValue(typed);
            expect(api.saveDecision).not.toHaveBeenCalled();
        },
    );

    it('範囲外（サーバーの 422）は、工場なら「生産要請数」の文言で示し、入力を保持する', async () => {
        const user = userEvent.setup();
        const api = fakeApi({
            getGameState: () => Promise.resolve(gameState({ role: 'FACTORY' })),
            getSessionState: () => Promise.resolve(playerState('FACTORY')),
            saveDecision: () =>
                Promise.reject(
                    new ApiError(422, {
                        type: '/problems/validation.invalid_input',
                        code: 'validation.invalid_input',
                        errors: [{ field: 'quantity', message: '数量は範囲外です。' }],
                    }),
                ),
        });
        renderApp(api, PATH);
        const input = await screen.findByLabelText('生産要請数');
        await user.type(input, '1001');
        await user.click(screen.getByRole('button', { name: '発注を保存' }));
        expect(
            await screen.findByText('生産要請数は 0〜1000 の整数で入力してください。'),
        ).toBeInTheDocument();
        expect(input).toHaveValue('1001');
    });

    it('保存の前に週が確定されていたら、週が進んだ旨を示し、入力欄を空にして、直前の値を参考に示す', async () => {
        const user = userEvent.setup();
        let advanced = false;
        const api = fakeApi({
            getGameState: () => Promise.resolve(gameState({ role: 'RETAILER' })),
            getSessionState: () =>
                Promise.resolve(
                    playerState('RETAILER', {
                        week: advanced ? 4 : 3,
                        versions: versions(advanced ? 8 : 5),
                    }),
                ),
            saveDecision: () => {
                advanced = true;
                return Promise.reject(
                    new ApiError(409, {
                        type: '/problems/session.week_advanced',
                        code: 'session.week_advanced',
                    }),
                );
            },
        });
        renderApp(api, PATH);
        const input = await screen.findByLabelText('発注数');
        await user.type(input, '10');
        await user.click(screen.getByRole('button', { name: '発注を保存' }));

        expect(await screen.findByText('第 3 週はすでに確定されています。')).toBeInTheDocument();
        expect(screen.getByText('第 3 週に入力していた値: 10（未保存）')).toBeInTheDocument();
        expect(screen.getByText(/^第 4 週\s+小売店$/)).toBeInTheDocument();
        expect(screen.getByLabelText('発注数')).toHaveValue('');
        // フォーカスを移して伝える通知は、role="alert" を併用しない
        expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    it('手動更新で週が変わったときは、打ちかけの値を空にして参考に示す。同じ週なら保持する', async () => {
        const user = userEvent.setup();
        let week = 3;
        const api = fakeApi({
            getGameState: () => Promise.resolve(gameState({ role: 'RETAILER' })),
            getSessionState: () => Promise.resolve(playerState('RETAILER', { week })),
        });
        renderApp(api, PATH);
        const input = await screen.findByLabelText('発注数');
        await user.type(input, '7');

        await user.click(screen.getByRole('button', { name: '手動更新' }));
        await waitFor(() => expect(api.getSessionState).toHaveBeenCalledTimes(2));
        expect(screen.getByLabelText('発注数')).toHaveValue('7');

        week = 4;
        await user.click(screen.getByRole('button', { name: '手動更新' }));
        expect(await screen.findByText('第 3 週に入力していた値: 7（未保存）')).toBeInTheDocument();
        expect(screen.getByLabelText('発注数')).toHaveValue('');
    });

    it('開始前は、開始を待つ旨を示し、手動更新で開始後の画面に切り替わる', async () => {
        const user = userEvent.setup();
        let started = false;
        const api = fakeApi({
            getGameState: () =>
                Promise.resolve(
                    started
                        ? gameState({ role: 'RETAILER' })
                        : gameState({
                              status: 'PREPARING',
                              sessionId: null,
                              role: 'RETAILER',
                              versions: versions(null, 3),
                          }),
                ),
            getSessionState: () => Promise.resolve(playerState('RETAILER')),
        });
        renderApp(api, PATH);
        expect(await screen.findByText('進行役が開始するまでお待ちください。')).toBeInTheDocument();
        expect(api.getSessionState).not.toHaveBeenCalled();

        started = true;
        await user.click(screen.getByRole('button', { name: '手動更新' }));
        expect(await screen.findByLabelText('発注数')).toBeInTheDocument();
    });

    it('終了後は、入力できない旨を示し、保存のボタンを出さない', async () => {
        const api = fakeApi({
            getGameState: () => Promise.resolve(gameState({ role: 'RETAILER', status: 'ENDED' })),
            getSessionState: () => Promise.resolve(playerState('RETAILER', { status: 'ENDED' })),
        });
        renderApp(api, PATH);
        expect(await screen.findByText('終了しました。入力できません。')).toBeInTheDocument();
        expect(screen.getByRole('link', { name: '振り返りを見る' })).toHaveAttribute(
            'href',
            `/games/${GAME_ID}/review`,
        );
        expect(screen.queryByRole('button', { name: '発注を保存' })).not.toBeInTheDocument();
    });

    it('権限が無ければ（無効な資格）、権限の文言と参加の画面への導線を示す', async () => {
        const api = fakeApi({
            getGameState: () =>
                Promise.reject(
                    new ApiError(403, {
                        type: '/problems/app.unauthorized',
                        code: 'app.unauthorized',
                    }),
                ),
        });
        renderApp(api, PATH);
        expect(await screen.findByText('この画面を開く権限がありません。')).toBeInTheDocument();
        // 復帰できるように、いまのゲームの ID を導線に持たせる
        expect(screen.getByRole('link', { name: '参加・復帰の画面へ' })).toHaveAttribute(
            'href',
            `/join?gameId=${GAME_ID}`,
        );
    });

    it('停止中は、停止中の旨と再開を待つ旨を示し、入力と保存を無効にし、入力中の値は保持する', async () => {
        const user = userEvent.setup();
        let paused = false;
        const api = fakeApi({
            getGameState: () => Promise.resolve(gameState({ role: 'RETAILER' })),
            getSessionState: () =>
                Promise.resolve(
                    playerState(
                        'RETAILER',
                        paused ? { status: 'PAUSED', versions: versions(6) } : {},
                    ),
                ),
        });
        renderApp(api, PATH);
        await user.type(await screen.findByLabelText('発注数'), '7');

        paused = true;
        await user.click(screen.getByRole('button', { name: '手動更新' }));

        expect(await screen.findByRole('status')).toHaveTextContent(
            '停止中です。進行役の再開を待ってください。',
        );
        expect(screen.getByLabelText('発注数')).toBeDisabled();
        expect(screen.getByLabelText('発注数')).toHaveValue('7');
        expect(screen.getByRole('button', { name: '発注を保存' })).toBeDisabled();
        expect(api.saveDecision).not.toHaveBeenCalled();
    });

    it('停止が解けると（再開）、入力欄が有効に戻り、入力中の値は残っている', async () => {
        const user = userEvent.setup();
        let status: SessionState['status'] = 'PAUSED';
        const api = fakeApi({
            getGameState: () => Promise.resolve(gameState({ role: 'RETAILER' })),
            getSessionState: () => Promise.resolve(playerState('RETAILER', { status })),
        });
        renderApp(api, PATH);
        expect(await screen.findByLabelText('発注数')).toBeDisabled();
        status = 'ACTIVE';
        await user.click(screen.getByRole('button', { name: '手動更新' }));
        await waitFor(() => expect(screen.getByLabelText('発注数')).toBeEnabled());
        expect(screen.queryByText('停止中です。進行役の再開を待ってください。')).toBeNull();
    });

    it('保存した瞬間に停止されていた（session.paused）ときは、停止中の文言を示し、入力を保持し、最新の状態で停止中に切り替える', async () => {
        const user = userEvent.setup();
        let paused = false;
        const api = fakeApi({
            getGameState: () => Promise.resolve(gameState({ role: 'RETAILER' })),
            getSessionState: () =>
                Promise.resolve(
                    playerState(
                        'RETAILER',
                        paused ? { status: 'PAUSED', versions: versions(6) } : {},
                    ),
                ),
            saveDecision: () => {
                paused = true;
                return Promise.reject(
                    new ApiError(409, {
                        type: '/problems/session.paused',
                        code: 'session.paused',
                        correlationId: 'c-p',
                    }),
                );
            },
        });
        renderApp(api, PATH);
        await user.type(await screen.findByLabelText('発注数'), '9');
        await user.click(screen.getByRole('button', { name: '発注を保存' }));

        expect(await screen.findByRole('alert')).toHaveTextContent(
            '停止中です。進行役の再開を待ってください。',
        );
        await waitFor(() => expect(screen.getByLabelText('発注数')).toBeDisabled());
        expect(screen.getByLabelText('発注数')).toHaveValue('9');
    });

    it('構造のアクセシビリティ（名前・参照先・見出し・題名）に違反が無い（入力中・停止中）', async () => {
        const user = userEvent.setup();
        let status: SessionState['status'] = 'ACTIVE';
        const api = fakeApi({
            getGameState: () => Promise.resolve(gameState({ role: 'RETAILER' })),
            getSessionState: () => Promise.resolve(playerState('RETAILER', { status })),
        });
        renderApp(api, PATH);
        await screen.findByLabelText('発注数');
        expectNoStructuralA11yViolations();
        status = 'PAUSED';
        await user.click(screen.getByRole('button', { name: '手動更新' }));
        await screen.findByText('停止中です。進行役の再開を待ってください。');
        expectNoStructuralA11yViolations();
    });

    it('取得の失敗は、区分と相関 ID を role="alert" で示す', async () => {
        const api = fakeApi({
            getGameState: () =>
                Promise.reject(
                    new ApiError(500, {
                        type: '/problems/app.internal',
                        code: 'app.internal',
                        correlationId: 'corr-5',
                    }),
                ),
        });
        renderApp(api, PATH);
        const alert = await screen.findByRole('alert');
        expect(alert).toHaveTextContent('corr-5');
    });
});

// ---- B6 Step 7: 共同担当・保存者・競合の表示（ui-design S05） ----

const SAVED_AT = '2026-11-16T01:42:00Z';
const savedClock = formatClock(SAVED_AT);

/** 共同担当（山本 = 自分、鈴木）の小売店。当週の入力は鈴木が 8 を保存済み（版 3）。 */
function coHolderState(overrides: Overrides = {}): SessionState {
    return playerState('RETAILER', {
        coHolders: [
            { displayName: '山本', isSelf: true },
            { displayName: '鈴木', isSelf: false },
        ],
        roleStatus: roleStatus({
            decision: 8,
            decisionVersion: 3,
            decisionEditor: { kind: 'PARTICIPANT', isSelf: false, displayName: '鈴木' },
            decisionSavedAt: SAVED_AT,
        }),
        ...overrides,
    });
}

const conflictOf = (editor: DecisionEntry['editor']): ApiError =>
    new ApiError(409, {
        type: '/problems/session.decision_conflict',
        code: 'session.decision_conflict',
        correlationId: 'corr-conflict',
        role: 'RETAILER',
        latest: { quantity: 8, version: 3, editor, savedAt: SAVED_AT },
    });

/** 山本が 10 を入力して保存し、競合（[editor] が先に 8 を保存済み）になった画面。 */
async function conflictedScreen(editor: DecisionEntry['editor']) {
    const user = userEvent.setup();
    const api = fakeApi({
        getGameState: () => Promise.resolve(gameState({ role: 'RETAILER' })),
        getSessionState: () => Promise.resolve(coHolderState()),
        saveDecision: () => Promise.reject(conflictOf(editor)),
    });
    renderApp(api, PATH);
    await user.type(await screen.findByLabelText('発注数'), '10');
    await user.click(screen.getByRole('button', { name: '発注を保存' }));
    return { api, user };
}

describe('S05 プレイ（共同入力）', () => {
    it('formatClock は、保存の時刻を「時:分」で示す（指定した時刻帯で）', () => {
        expect(formatClock('2026-11-16T01:42:00Z', 'Asia/Tokyo')).toBe('10:42');
        expect(formatClock('2026-11-16T01:42:00Z', 'UTC')).toBe('01:42');
    });

    it('共同担当がいるときだけ、見出しの行に共同担当を示す（自分には「あなた」を添える）', async () => {
        const api = fakeApi({
            getGameState: () => Promise.resolve(gameState({ role: 'RETAILER' })),
            getSessionState: () => Promise.resolve(coHolderState()),
        });
        renderApp(api, PATH);

        expect(await screen.findByText(/^第 3 週\s+小売店$/)).toBeInTheDocument();
        expect(screen.getByText('共同担当: 山本（あなた）、鈴木')).toBeInTheDocument();
    });

    it('共同担当が自分だけなら、共同担当の行は出さない', async () => {
        const api = fakeApi({
            getGameState: () => Promise.resolve(gameState({ role: 'RETAILER' })),
            getSessionState: () =>
                Promise.resolve(
                    playerState('RETAILER', { coHolders: [{ displayName: '山本', isSelf: true }] }),
                ),
        });
        renderApp(api, PATH);
        await screen.findByLabelText('発注数');
        expect(screen.queryByText(/共同担当:/)).not.toBeInTheDocument();
    });

    it('現在の入力に、最後の保存者と時刻を添える（他の人・自分・進行役の代理入力）', async () => {
        let editor: NonNullable<SessionState['roleStatus']>['decisionEditor'] = {
            kind: 'PARTICIPANT',
            isSelf: false,
            displayName: '鈴木',
        };
        const api = fakeApi({
            getGameState: () => Promise.resolve(gameState({ role: 'RETAILER' })),
            getSessionState: () =>
                Promise.resolve(
                    coHolderState({
                        roleStatus: roleStatus({
                            decision: 8,
                            decisionVersion: 3,
                            decisionEditor: editor,
                            decisionSavedAt: SAVED_AT,
                        }),
                    }),
                ),
        });
        const user = userEvent.setup();
        renderApp(api, PATH);

        expect(
            await screen.findByText(`現在の入力: 8（鈴木さんが ${savedClock} に保存）`),
        ).toBeInTheDocument();

        editor = { kind: 'PARTICIPANT', isSelf: true, displayName: '山本' };
        await user.click(screen.getByRole('button', { name: '手動更新' }));
        expect(
            await screen.findByText(`現在の入力: 8（あなたが ${savedClock} に保存）`),
        ).toBeInTheDocument();

        editor = { kind: 'FACILITATOR_PROXY', isSelf: false };
        await user.click(screen.getByRole('button', { name: '手動更新' }));
        expect(
            await screen.findByText(`現在の入力: 8（進行役（代理入力）が ${savedClock} に保存）`),
        ).toBeInTheDocument();
    });

    it('競合したとき、最新の値・保存者・時刻と、入力の保持を示し、版は画面に出さない', async () => {
        await conflictedScreen({ kind: 'PARTICIPANT', isSelf: false, displayName: '鈴木' });

        const notice = await screen.findByRole('region', { name: '他の人が先に保存しました。' });
        expect(within(notice).getByText('最新の入力: 8')).toBeInTheDocument();
        expect(within(notice).getByText(`保存者: 鈴木さん（${savedClock}）`)).toBeInTheDocument();
        expect(
            within(notice).getByText('あなたの入力: 10（未保存。保持しています）'),
        ).toBeInTheDocument();
        expect(notice).not.toHaveTextContent(/版/);
        // 入力欄の値は、そのまま残る（黙って失わない）
        expect(screen.getByLabelText('発注数')).toHaveValue('10');
    });

    it('競合の見出しにフォーカスを移す（通知に気づける）', async () => {
        await conflictedScreen({ kind: 'PARTICIPANT', isSelf: false, displayName: '鈴木' });
        const heading = await screen.findByRole('heading', { name: '他の人が先に保存しました。' });
        await waitFor(() => expect(heading).toHaveFocus());
    });

    it('進行役の代理入力が先なら、見出しを「進行役が代理で入力しました。」にし、保存者を「進行役（代理入力）」と示す', async () => {
        await conflictedScreen({ kind: 'FACILITATOR_PROXY', isSelf: false });

        const notice = await screen.findByRole('region', { name: '進行役が代理で入力しました。' });
        expect(
            within(notice).getByText(`保存者: 進行役（代理入力）（${savedClock}）`),
        ).toBeInTheDocument();
    });

    it('保存者が自分なら、「あなたが 時刻 に保存した値があります。」と示す', async () => {
        await conflictedScreen({ kind: 'PARTICIPANT', isSelf: true, displayName: '山本' });

        const notice = await screen.findByRole('region', { name: '他の人が先に保存しました。' });
        expect(
            within(notice).getByText(`あなたが ${savedClock} に保存した値があります。`),
        ).toBeInTheDocument();
    });

    it('「最新の値を使う」を選ぶと、入力欄を最新の値にし、競合の表示を閉じる（保存はしない）', async () => {
        const { api, user } = await conflictedScreen({
            kind: 'PARTICIPANT',
            isSelf: false,
            displayName: '鈴木',
        });

        await user.click(await screen.findByRole('button', { name: '最新の値を使う' }));

        expect(screen.getByLabelText('発注数')).toHaveValue('8');
        expect(screen.queryByRole('region', { name: '他の人が先に保存しました。' })).toBeNull();
        expect(api.saveDecision).toHaveBeenCalledTimes(1);
    });

    it('「この値で保存し直す」を選ぶと、競合で知った最新の版を添えて、入力した値を保存する', async () => {
        const user = userEvent.setup();
        let saves = 0;
        const api = fakeApi({
            getGameState: () => Promise.resolve(gameState({ role: 'RETAILER' })),
            getSessionState: () =>
                Promise.resolve(
                    saves < 2
                        ? coHolderState()
                        : coHolderState({
                              roleStatus: roleStatus({
                                  decision: 10,
                                  decisionVersion: 4,
                                  decisionEditor: {
                                      kind: 'PARTICIPANT',
                                      isSelf: true,
                                      displayName: '山本',
                                  },
                                  decisionSavedAt: SAVED_AT,
                              }),
                              versions: versions(7),
                          }),
                ),
            saveDecision: () => {
                saves++;
                return saves === 1
                    ? Promise.reject(
                          conflictOf({ kind: 'PARTICIPANT', isSelf: false, displayName: '鈴木' }),
                      )
                    : Promise.resolve({ versions: versions(7) });
            },
        });
        renderApp(api, PATH);
        await user.type(await screen.findByLabelText('発注数'), '10');
        await user.click(screen.getByRole('button', { name: '発注を保存' }));

        await user.click(await screen.findByRole('button', { name: 'この値で保存し直す' }));

        expect(api.saveDecision).toHaveBeenLastCalledWith(GAME_ID, { week: 3, quantity: 10 }, 3);
        expect(
            await screen.findByText(`現在の入力: 10（あなたが ${savedClock} に保存）`),
        ).toBeInTheDocument();
        expect(screen.queryByRole('region', { name: '他の人が先に保存しました。' })).toBeNull();
    });

    it('競合の表示の構造のアクセシビリティ（名前・参照先・見出し・題名）に違反が無い', async () => {
        await conflictedScreen({ kind: 'PARTICIPANT', isSelf: false, displayName: '鈴木' });
        await screen.findByRole('region', { name: '他の人が先に保存しました。' });
        expectNoStructuralA11yViolations();
    });
});
