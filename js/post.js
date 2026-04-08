(function() {
  async function init() {
    const params = new URLSearchParams(window.location.search);
    const postId = params.get('id');
    const container = document.getElementById('post-content');

    if (!postId) {
      showError(container, '글 ID가 지정되지 않았습니다.');
      return;
    }

    try {
      const res = await fetch('posts.json');
      const data = await res.json();
      const postMeta = data.posts.find(p => p.id === postId);

      if (!postMeta) {
        showError(container, '존재하지 않는 글입니다.');
        return;
      }

      const postRes = await fetch(postMeta.filename);
      if (!postRes.ok) throw new Error('Failed to load post');
      const html = await postRes.text();

      container.innerHTML = html;
      document.title = postMeta.title + ' - Hamser Diary';
    } catch (e) {
      showError(container, '글을 불러올 수 없습니다.');
    }
  }

  function showError(container, message) {
    container.innerHTML =
      '<div class="empty-state">' +
        '<div class="empty-state-icon">🔍</div>' +
        '<p>' + message + '</p>' +
        '<a href="index.html" style="margin-top:1rem;display:inline-block;">홈으로 돌아가기</a>' +
      '</div>';
  }

  document.addEventListener('DOMContentLoaded', init);
})();
