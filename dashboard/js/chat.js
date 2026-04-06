export function renderChatMessages(messages) {
  if (!messages.length) {
    return '<p class="project-meta">チャット履歴はまだありません。</p>';
  }

  return messages
    .map(
      (message) => `
        <article class="message ${message.role}">
          <small>${roleLabel(message.role)} / フェーズ ${message.phase} / ${message.createdAt}</small>
          <div>${escapeHtml(message.content).replaceAll("\n", "<br />")}</div>
        </article>
      `,
    )
    .join("");
}

function roleLabel(role) {
  if (role === "user") {
    return "あなた";
  }
  if (role === "assistant") {
    return "Codex";
  }
  return "システム";
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
