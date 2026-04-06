export function renderSetupWizard(config) {
  return `
    <p class="setup-intro">
      最初に MT5 と Codex の場所を確認します。わからない場合は、まず接続テストを押してください。
    </p>
    <div class="settings-grid">
      <div class="field">
        <label for="setting-terminal">MT5 本体パス</label>
        <input id="setting-terminal" data-setting="mt5.terminal_path" value="${escapeHtml(config.mt5.terminal_path)}" />
        <p class="field-note">MT5 本体の場所です。</p>
      </div>
      <div class="field">
        <label for="setting-editor">MetaEditor パス</label>
        <input id="setting-editor" data-setting="mt5.metaeditor_path" value="${escapeHtml(config.mt5.metaeditor_path)}" />
        <p class="field-note">EA をコンパイルする MetaEditor の場所です。</p>
      </div>
      <div class="field">
        <label for="setting-data-folder">MT5 データフォルダ</label>
        <input id="setting-data-folder" data-setting="mt5.data_folder" value="${escapeHtml(config.mt5.data_folder)}" />
        <p class="field-note">レポートや EA ファイルが保存される作業フォルダです。</p>
      </div>
      <div class="field">
        <label for="setting-codex-command">Codex コマンド</label>
        <input id="setting-codex-command" data-setting="codex.command" value="${escapeHtml(config.codex.command)}" />
        <p class="field-note">通常は <code>codex</code> のままで大丈夫です。</p>
      </div>
      <div class="field">
        <label for="setting-timeout">Codex タイムアウト秒数</label>
        <input id="setting-timeout" data-setting="codex.timeout_seconds" value="${escapeHtml(String(config.codex.timeout_seconds))}" />
        <p class="field-note">AI の返答を待つ秒数です。</p>
      </div>
      <div class="field">
        <label for="setting-port">サーバーポート</label>
        <input id="setting-port" data-setting="server.port" value="${escapeHtml(String(config.server.port))}" />
        <p class="field-note">通常は 3000 のままで構いません。</p>
      </div>
    </div>
  `;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
