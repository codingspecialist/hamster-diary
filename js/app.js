(function() {
  const POSTS_PER_PAGE = 6;
  let allPosts = [];
  let categories = [];
  let currentCategory = null;
  let currentPage = 1;

  async function init() {
    try {
      const res = await fetch('posts.json');
      const data = await res.json();
      allPosts = data.posts.sort((a, b) => new Date(b.date) - new Date(a.date));
      categories = data.categories || [];
      renderCategories();
      renderPage();
    } catch (e) {
      document.getElementById('post-grid').innerHTML =
        '<div class="empty-state"><div class="empty-state-icon">📭</div><p>글을 불러올 수 없습니다.</p></div>';
    }
  }

  function getFilteredPosts() {
    if (!currentCategory) return allPosts;
    return allPosts.filter(p => p.category === currentCategory);
  }

  function renderCategories() {
    const list = document.getElementById('category-list');
    const counts = {};
    allPosts.forEach(p => {
      counts[p.category] = (counts[p.category] || 0) + 1;
    });

    let html = '<li><button class="category-btn active" data-category="">' +
      '전체 <span class="category-count">' + allPosts.length + '</span></button></li>';

    categories.forEach(cat => {
      const count = counts[cat] || 0;
      html += '<li><button class="category-btn" data-category="' + cat + '">' +
        cat + ' <span class="category-count">' + count + '</span></button></li>';
    });

    list.innerHTML = html;

    list.addEventListener('click', function(e) {
      const btn = e.target.closest('.category-btn');
      if (!btn) return;
      currentCategory = btn.dataset.category || null;
      currentPage = 1;
      list.querySelectorAll('.category-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      renderPage();
    });
  }

  function renderPage() {
    const filtered = getFilteredPosts();
    const totalPages = Math.ceil(filtered.length / POSTS_PER_PAGE) || 1;
    if (currentPage > totalPages) currentPage = totalPages;

    const start = (currentPage - 1) * POSTS_PER_PAGE;
    const pagePosts = filtered.slice(start, start + POSTS_PER_PAGE);

    const grid = document.getElementById('post-grid');

    if (pagePosts.length === 0) {
      grid.innerHTML = '<div class="empty-state"><div class="empty-state-icon">📝</div>' +
        '<p>이 카테고리에 글이 없습니다.</p></div>';
    } else {
      grid.innerHTML = pagePosts.map(post =>
        '<a class="post-card" href="post.html?id=' + post.id + '">' +
          '<span class="post-card-category">' + post.category + '</span>' +
          '<h3 class="post-card-title">' + post.title + '</h3>' +
          '<p class="post-card-summary">' + post.summary + '</p>' +
          '<time class="post-card-date">' + post.date + '</time>' +
        '</a>'
      ).join('');
    }

    renderPagination(totalPages);
  }

  function renderPagination(totalPages) {
    const container = document.getElementById('pagination');
    if (totalPages <= 1) {
      container.innerHTML = '';
      return;
    }

    let html = '<button class="page-btn" data-page="prev" ' +
      (currentPage === 1 ? 'disabled' : '') + '>&laquo; 이전</button>';

    for (let i = 1; i <= totalPages; i++) {
      html += '<button class="page-btn' + (i === currentPage ? ' active' : '') +
        '" data-page="' + i + '">' + i + '</button>';
    }

    html += '<button class="page-btn" data-page="next" ' +
      (currentPage === totalPages ? 'disabled' : '') + '>다음 &raquo;</button>';

    container.innerHTML = html;

    container.addEventListener('click', function handler(e) {
      const btn = e.target.closest('.page-btn');
      if (!btn || btn.disabled) return;
      const page = btn.dataset.page;
      if (page === 'prev') currentPage--;
      else if (page === 'next') currentPage++;
      else currentPage = parseInt(page);
      renderPage();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
  }

  document.addEventListener('DOMContentLoaded', init);
})();
