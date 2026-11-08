// GitHub 링크를 현재 주소(https://<아이디>.github.io/<저장소>/)에서 자동으로 계산합니다.
// github.io 가 아닌 곳(로컬 미리보기 등)에서는 아래 FALLBACK 을 사용합니다.
// → 저장소 주소를 바꿀 때 이 한 줄만 고치면 됩니다.
(function () {
  var FALLBACK = 'https://github.com/mungi/ncp-console-plus';
  var repo = FALLBACK;

  var host = location.hostname;
  var m = host.match(/^([a-z0-9-]+)\.github\.io$/i);
  if (m) {
    var first = location.pathname.split('/').filter(Boolean)[0];
    // 프로젝트 페이지: <아이디>.github.io/<저장소>/ , 사용자 페이지는 저장소 이름을 알 수 없어 FALLBACK 유지
    if (first && !/\.html?$/i.test(first) && first !== 'assets') {
      repo = 'https://github.com/' + m[1] + '/' + first;
    }
  }

  var targets = {
    repo: repo,
    issues: repo + '/issues',
    releases: repo + '/releases',
  };
  document.querySelectorAll('[data-gh]').forEach(function (a) {
    var url = targets[a.getAttribute('data-gh')];
    if (url) a.setAttribute('href', url);
  });
})();
