import { Link } from 'react-router';
import { PageHeading } from '../../components/PageHeading';

/** S01 はじめる */
export function WelcomePage() {
    return (
        <>
            <PageHeading title="ビールゲーム" />
            <p>サプライチェーンの 4 役割を体験する学習ゲームです。</p>
            <nav aria-label="はじめる">
                <ul className="actions">
                    <li>
                        <Link to="/new" className="button">
                            ゲームを作る
                        </Link>
                    </li>
                    <li>
                        <Link to="/join" className="button">
                            参加・復帰
                        </Link>
                    </li>
                </ul>
            </nav>
        </>
    );
}
