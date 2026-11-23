import type { ExportFile } from '../api/types';

/**
 * 受け取ったファイルを、ブラウザのダウンロードとして保存する（Blob の URL と、download 属性つきのリンク）。
 * 名前はサーバーが決めた値をそのまま使う。作った URL は、押したあとに解放する。
 */
export function downloadFile(file: ExportFile): void {
    const url = URL.createObjectURL(file.blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = file.filename;
    document.body.append(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
}
