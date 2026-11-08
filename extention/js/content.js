// Naver Cloud Console - 서버 접속 콘솔(VNC) 전체화면 + 자동 연장
//
// 콘솔 모달 구조 (console.ncloud.com/vpc-compute 번들 기준):
//   <p><span>남은 접속 시간: 04:59</span><span>(전체 연결 시간: 00:13)</span><br><button>연장</button></p>
//   <iframe src="https://svr-console-kr.ncloud.com:19090/console/console.html?...">
// - "연장" 클릭 시 서버가 남은 시간을 300초로 재설정
// - 전체 연결 시간이 20분에 도달하면 콘솔이 강제로 닫힘 (서비스 정책, 우회 불가)
(() => {
  'use strict';

  if (window.__ncloudFullscreenLoaded) return;
  window.__ncloudFullscreenLoaded = true;

  const IFRAME_SELECTOR = 'iframe[src*="svr-console-kr.ncloud.com"]';
  const EXTEND_LABEL = '연장';
  // "남은 접속 시간: 04:59(전체 연결 시간: 00:13)" - 공백/콜론 유무에 관대하게 매칭
  const TIME_REGEX = /남은\s*접속\s*시간\s*:?\s*(\d{1,3}):(\d{1,2})\s*\(\s*전체\s*연결\s*시간\s*:?\s*(\d{1,3}):(\d{1,2})\s*\)/;

  const SESSION_SEC = 300;                 // 연장 1회당 부여되는 시간
  const MAX_TOTAL_SEC = 20 * 60;           // 콘솔 최대 연결 시간
  const EXTEND_THRESHOLD_SEC = 60;         // 표시된 남은 시간이 이 값 이하이면 연장
  const MAX_SINCE_RESET_MS = (3 * 60 + 45) * 1000; // 표시 시간과 무관하게, 마지막 연장 후 3분 45초가 지나면 연장
  const TICK_INTERVAL_MS = 15 * 1000;      // 주기 점검 간격 (최악의 경우 3:45 + 15초 = 만료 1분 전)
  const EXTEND_COOLDOWN_MS = 10 * 1000;    // 연장 클릭 후 재시도 대기 (점검 간격보다 짧게)
  const STORAGE_KEY = 'autoExtendEnabled';

  const FS_BTN_ID = 'ncloud-fullscreen-btn';         // 진짜 전체화면 (Fullscreen API)
  const WIN_BTN_ID = 'ncloud-window-fullscreen-btn'; // 브라우저 창 전체화면 (CSS)
  const AUTO_TEXT_ID = 'ncloud-auto-extend-text';
  const BELL_BTN_ID = 'ncloud-end-warning-btn';      // 20분 종료 예고 on/off

  const COLOR_IDLE = '#00873C';
  const COLOR_IDLE_HOVER = '#00732F';
  const COLOR_ACTIVE = '#d32f2f';
  const COLOR_ACTIVE_HOVER = '#b71c1c';

  // 24x24 stroke 아이콘 path
  const ICONS = {
    // 모니터 전체: 네 모서리 확장 / 축소
    screenEnter: ['M4 9V4h5', 'M20 9V4h-5', 'M4 15v5h5', 'M20 15v5h-5'],
    screenExit: ['M9 4v5H4', 'M15 4v5h5', 'M9 20v-5H4', 'M15 20v-5h5'],
    // 브라우저 창: 창 틀 + 대각선 확장 / 축소 화살표
    windowEnter: ['M3 6a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z', 'M3 8h18', 'M9 17l6-6', 'M11 11h4v4'],
    windowExit: ['M3 6a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z', 'M3 8h18', 'M9 17l6-6', 'M9 13v4h4'],
    // 알림(종): 켜짐 / 꺼짐(사선)
    bellOn: ['M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9', 'M13.73 21a2 2 0 0 1-3.46 0'],
    bellOff: ['M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9', 'M13.73 21a2 2 0 0 1-3.46 0', 'M3 3l18 18'],
  };

  let autoExtendEnabled = true;
  let fallbackIframe = null;      // CSS 대체 전체화면이 적용된 iframe
  let fallbackSavedStyle = '';
  let lastExtendClickAt = -Infinity;
  let lastRemaining = null;
  let lastResetAt = 0;
  let limitLogged = false;
  let sessionStartAt = null;   // performance.now() 기준 세션 시작 시각
  let lastPageElapsed = null;
  let mutationTimer = null;

  // ---------- 설정 (팝업과 chrome.storage.sync 로 공유) ----------
  const TAB_RENAME_KEY = 'tabRenameEnabled';            // 탭 제목/리전 아이콘
  // 서버 접속 콘솔에 추가한 기능 전체의 on/off (팝업 토글).
  // 끄면 전체화면 버튼·자동연장 스위치·종 아이콘을 모두 빼고 자동 연장·종료 예고도 멈춤 (원래 "연장" 버튼만 남음).
  // 자동연장·종료 예고 개별 설정은 보존되어 다시 켜면 이전 상태로 돌아감.
  // 저장 키 이름은 기존 사용자 설정 유지를 위해 그대로 둠.
  const FULLSCREEN_KEY = 'consoleFullscreenEnabled';
  const END_WARNING_KEY = 'endWarningEnabled';          // 20분 종료 예고
  let tabRenameEnabled = true;
  let consoleFeaturesEnabled = true;
  let endWarningEnabled = true;

  function applySettings(items) {
    if (STORAGE_KEY in items) {
      autoExtendEnabled = items[STORAGE_KEY] !== false;
      updateAutoExtendText();
    }
    if (TAB_RENAME_KEY in items) {
      const next = items[TAB_RENAME_KEY] !== false;
      if (tabRenameEnabled && !next) restoreTabIdentity();
      tabRenameEnabled = next;
    }
    if (FULLSCREEN_KEY in items) {
      const next = items[FULLSCREEN_KEY] !== false;
      if (consoleFeaturesEnabled && !next) {
        // 끄면 진행 중인 전체화면도 해제하고 버튼을 제거
        if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
        removeFallback();
        removeInjectedUi();
      }
      consoleFeaturesEnabled = next;
      renderEndWarning();
    }
    if (END_WARNING_KEY in items) {
      endWarningEnabled = items[END_WARNING_KEY] !== false;
      updateBellButton();
      renderEndWarning();
    }
    scheduleTick();
  }

  // start() 에서 호출 (모든 상태 변수가 선언된 뒤에 설정을 적용하기 위해)
  function loadSettings() {
    try {
      // 설정(sync)과 탭 제목 캐시(local)를 모두 읽은 뒤에 제목 변경 시작
      let pending = 2;
      const done = () => {
        if (--pending > 0) return;
        settingsLoaded = true;
        updateTabIdentity();
      };
      chrome.storage.local.get({ [TITLE_CACHE_KEY]: {} }, (items) => {
        if (!chrome.runtime.lastError && items[TITLE_CACHE_KEY]) titleCache = items[TITLE_CACHE_KEY];
        done();
      });
      chrome.storage.sync.get(
        { [STORAGE_KEY]: true, [TAB_RENAME_KEY]: true, [FULLSCREEN_KEY]: true, [END_WARNING_KEY]: true },
        (items) => {
          if (!chrome.runtime.lastError) applySettings(items);
          done();
        });
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'sync') return;
        const items = {};
        for (const k of Object.keys(changes)) items[k] = changes[k].newValue;
        applySettings(items);
      });
    } catch (e) {
      // storage 권한이 없거나 컨텍스트가 무효화된 경우 기본값 사용
    }
  }

  function setAutoExtend(enabled) {
    autoExtendEnabled = enabled;
    updateAutoExtendText();
    try {
      chrome.storage.sync.set({ [STORAGE_KEY]: enabled });
    } catch (e) { /* 무시 */ }
  }

  // ---------- DOM 탐색 ----------
  function isVisible(el) {
    return el.isConnected && el.getClientRects().length > 0;
  }

  function findExtendButton() {
    const candidates = document.querySelectorAll('button, a, [role="button"]');
    for (const el of candidates) {
      if (el.id === FS_BTN_ID) continue;
      if (el.textContent && el.textContent.trim() === EXTEND_LABEL && isVisible(el)) {
        return el;
      }
    }
    return null;
  }

  // 연장 버튼 주변에서 남은/전체 시간 파싱 (body.innerText 전체 스캔 회피)
  function readTimes(extendButton) {
    let node = extendButton.parentElement;
    for (let depth = 0; node && depth < 5; depth++, node = node.parentElement) {
      const m = (node.textContent || '').match(TIME_REGEX);
      if (m) {
        return {
          remaining: parseInt(m[1], 10) * 60 + parseInt(m[2], 10),
          elapsed: parseInt(m[3], 10) * 60 + parseInt(m[4], 10),
        };
      }
    }
    return null;
  }

  // ---------- 자동 연장 ----------
  // 시간 기준은 performance.now() (단조 증가: 시스템 시계 변경 영향 없음, 탭 throttling 과 무관)
  function resetSessionState() {
    lastRemaining = null;
    lastResetAt = 0;
    lastExtendClickAt = -Infinity;
    limitLogged = false;
    sessionStartAt = null;
    lastPageElapsed = null;
    warningDismissed = false;
    hideEndWarning();
  }

  // 페이지의 "전체 연결 시간"은 setInterval 로 1초씩 세는 값이라 백그라운드 탭에서 느려짐.
  // 세션 시작 시각을 기억해 두고 (현재 - 시작)으로 실제 경과 시간을 계산.
  function updateSessionClock(times, now) {
    const isNewSession = sessionStartAt === null ||
      (lastPageElapsed !== null && times.elapsed < lastPageElapsed - 2); // 페이지 카운터가 되돌아감 = 새 세션
    if (isNewSession) {
      // 확장이 세션 도중에 로드된 경우를 위해 페이지 값만큼 거슬러 시작 시각 추정
      sessionStartAt = now - times.elapsed * 1000;
      lastRemaining = null;
      limitLogged = false;
      warningDismissed = false;
    }
    lastPageElapsed = times.elapsed;
    times.realElapsed = Math.floor((now - sessionStartAt) / 1000);
    // 둘 중 큰 값을 기준으로 (페이지 카운터는 실제보다 빨라질 수 없음)
    times.effectiveElapsed = Math.max(times.elapsed, times.realElapsed);
    return times;
  }

  // ---------- 20분 종료 예고 ----------
  const WARNING_ID = 'ncloud-end-warning';
  const WARN_BEFORE_SEC = 2 * 60;          // 종료 2분 전부터 표시
  let warningTimer = null;
  let warningDismissed = false;

  function secondsUntilForcedEnd() {
    if (sessionStartAt === null || lastPageElapsed === null) return null;
    const real = (performance.now() - sessionStartAt) / 1000;
    return Math.ceil(MAX_TOTAL_SEC - Math.max(real, lastPageElapsed));
  }

  let warningStartTimer = null;

  function hideEndWarning() {
    document.getElementById(WARNING_ID)?.remove();
    if (warningTimer) { clearInterval(warningTimer); warningTimer = null; }
    if (warningStartTimer) { clearTimeout(warningStartTimer); warningStartTimer = null; }
  }

  function renderEndWarning() {
    const left = secondsUntilForcedEnd();
    if (left === null || warningDismissed || !endWarningEnabled || !consoleFeaturesEnabled) {
      hideEndWarning();
      return;
    }
    if (left > WARN_BEFORE_SEC) {
      hideEndWarning();
      // 15초 주기 점검을 기다리지 않고 표시 시점에 정확히 다시 확인
      warningStartTimer = setTimeout(renderEndWarning, (left - WARN_BEFORE_SEC) * 1000 + 50);
      return;
    }
    // 전체화면 중이면 그 영역 안에, 아니면 body 에 (창 전체화면 iframe 보다 위)
    const host = document.fullscreenElement && document.fullscreenElement.tagName !== 'IFRAME'
      ? document.fullscreenElement : document.body;
    let box = document.getElementById(WARNING_ID);
    if (!box) {
      box = document.createElement('div');
      box.id = WARNING_ID;
      box.setAttribute('role', 'alert');
      Object.assign(box.style, {
        position: 'fixed',
        top: '12px',
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: '2147483647',
        display: 'flex',
        alignItems: 'center',
        gap: '12px',
        padding: '10px 14px',
        borderRadius: '6px',
        fontFamily: "'Malgun Gothic', Arial, sans-serif",
        fontSize: '14px',
        fontWeight: 'bold',
        boxShadow: '0 2px 8px rgba(0,0,0,0.35)',
        maxWidth: 'calc(100vw - 112px)', // 오른쪽 위 창 전체화면 종료 버튼과 겹치지 않게
        pointerEvents: 'auto',
      });
      const text = document.createElement('span');
      text.dataset.part = 'text';
      const close = document.createElement('button');
      close.type = 'button';
      close.textContent = '×';
      close.title = '닫기';
      close.setAttribute('aria-label', '종료 예고 닫기');
      Object.assign(close.style, {
        border: 'none',
        background: 'transparent',
        color: 'inherit',
        fontSize: '18px',
        lineHeight: '1',
        cursor: 'pointer',
        padding: '0 2px',
      });
      close.addEventListener('click', (e) => {
        e.stopPropagation();
        warningDismissed = true;
        hideEndWarning();
      });
      box.append(text, close);
    }
    if (box.parentNode !== host) host.appendChild(box);

    const t = Math.max(0, left);
    const mm = Math.floor(t / 60);
    const ss = String(t % 60).padStart(2, '0');
    box.querySelector('[data-part="text"]').textContent = t > 0
      ? `⏱ 서버 접속 콘솔이 ${mm}:${ss} 후 종료됩니다 (최대 20분)`
      : '⏱ 서버 접속 콘솔이 곧 종료됩니다 (최대 20분)';
    // 대비(WCAG AA): 마지막 1분은 빨강 + 흰 글자, 그 전에는 호박색 + 어두운 글자
    const urgent = t <= 60;
    box.style.top = document.getElementById(WIN_BAR_ID) ? '52px' : '12px'; // 창 전체화면 막대(시간+종료 버튼) 아래
    box.style.backgroundColor = urgent ? '#c62828' : '#ffb300';
    box.style.color = urgent ? '#ffffff' : '#1b1f1d';

    if (!warningTimer) warningTimer = setInterval(renderEndWarning, 1000);
  }

  function maybeAutoExtend(extendButton, times) {
    if (!times) return;
    const now = performance.now();
    updateSessionClock(times, now);
    renderEndWarning();

    // 남은 시간이 늘어났다면(수동/자동 연장 성공, 새 세션) 기준 시각 갱신
    if (lastRemaining === null || times.remaining > lastRemaining + 2) {
      lastResetAt = now - Math.max(0, SESSION_SEC - times.remaining) * 1000;
    }
    lastRemaining = times.remaining;

    if (!autoExtendEnabled || !consoleFeaturesEnabled) return;

    if (times.effectiveElapsed >= MAX_TOTAL_SEC) {
      if (!limitLogged) {
        console.info('[ncloud-ext] 전체 연결 시간 20분 도달: 자동 연장 중지 (실제 ' +
                     times.realElapsed + '초, 화면 ' + times.elapsed + '초)');
        limitLogged = true;
      }
      return;
    }

    // 표시된 남은 시간도 페이지 타이머라 느려질 수 있으므로 실제 경과 시간 기준으로도 판단
    const due = times.remaining <= EXTEND_THRESHOLD_SEC ||
                (now - lastResetAt) >= MAX_SINCE_RESET_MS;
    if (!due) return;
    if (now - lastExtendClickAt < EXTEND_COOLDOWN_MS) return;
    if (extendButton.disabled || extendButton.getAttribute('aria-disabled') === 'true') return;

    lastExtendClickAt = now;
    console.info('[ncloud-ext] 자동 연장 클릭 (남은 ' + times.remaining + '초, 전체 실제 ' +
                 times.realElapsed + '초 / 화면 ' + times.elapsed + '초)');
    extendButton.click();
  }

  // ---------- 전체화면 ----------
  // 창 전체화면 중에는 iframe 이 콘솔 위 버튼과 시간 표시를 덮고, 포커스가 iframe(다른 origin) 안에 있으면
  // Esc 가 VM 으로 전달되어 종료할 수 없으므로, 오른쪽 위에 항상 보이는 막대를 띄움:
  //   [남은 접속 시간: 04:43 (전체 연결 시간: 00:17)] [종료 버튼]
  const WIN_EXIT_ID = 'ncloud-window-exit-btn';
  const WIN_BAR_ID = 'ncloud-window-exit-bar';
  const WIN_TIME_ID = 'ncloud-window-time';
  let windowTimeTimer = null;

  function formatClock(sec) {
    const m = Math.floor(sec / 60);
    return String(m).padStart(2, '0') + ':' + String(sec % 60).padStart(2, '0');
  }

  // 콘솔이 표시하는 값(덮여 있어도 DOM 에는 계속 갱신됨)을 그대로 읽어서 표시
  function updateWindowTime() {
    const el = document.getElementById(WIN_TIME_ID);
    if (!el) return;
    const extendButton = findExtendButton();
    const t = extendButton ? readTimes(extendButton) : null;
    if (!t) {
      el.style.display = 'none';
      return;
    }
    el.style.display = '';
    el.textContent = '남은 접속 시간: ' + formatClock(t.remaining) + ' (전체 연결 시간: ' + formatClock(t.elapsed) + ')';
  }

  function showWindowExitButton() {
    if (document.getElementById(WIN_BAR_ID)) return;
    const bar = document.createElement('div');
    bar.id = WIN_BAR_ID;
    Object.assign(bar.style, {
      position: 'fixed',
      top: '8px',
      right: '8px',
      zIndex: '2147483647',
      display: 'flex',
      alignItems: 'center',
      gap: '8px',
      maxWidth: 'calc(100vw - 16px)',
    });

    const time = document.createElement('span');
    time.id = WIN_TIME_ID;
    Object.assign(time.style, {
      padding: '6px 10px',
      borderRadius: '4px',
      backgroundColor: 'rgba(0, 0, 0, 0.72)',
      color: '#ffffff',
      fontFamily: "'Malgun Gothic', Arial, sans-serif",
      fontSize: '13px',
      fontWeight: 'bold',
      lineHeight: '20px',
      whiteSpace: 'nowrap',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      display: 'none',
    });

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.id = WIN_EXIT_ID;
    btn.title = '창 전체화면 종료';
    btn.setAttribute('aria-label', '창 전체화면 종료');
    btn.appendChild(createIcon(ICONS.windowExit));
    Object.assign(btn.style, {
      display: 'inline-flex',
      flex: 'none',
      alignItems: 'center',
      justifyContent: 'center',
      width: '32px',
      height: '32px',
      padding: '0',
      border: 'none',
      borderRadius: '4px',
      backgroundColor: COLOR_ACTIVE,
      color: 'white',
      cursor: 'pointer',
      opacity: '0.45',
      transition: 'opacity 0.15s',
    });
    btn.addEventListener('mouseenter', () => { btn.style.opacity = '1'; });
    btn.addEventListener('mouseleave', () => { btn.style.opacity = '0.45'; });
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      removeFallback();
      updateButtonState();
    });

    bar.append(time, btn);
    document.body.appendChild(bar);
    updateWindowTime();
    windowTimeTimer = setInterval(updateWindowTime, 1000);
    renderEndWarning(); // 종료 예고가 떠 있으면 막대 아래로 위치 조정
  }

  function applyFallback(iframe) {
    showWindowExitButton();
    fallbackIframe = iframe;
    fallbackSavedStyle = iframe.getAttribute('style') || '';
    Object.assign(iframe.style, {
      position: 'fixed',
      top: '0',
      left: '0',
      width: '100vw',
      height: '100vh',
      zIndex: '2147483647',
    });
  }

  function removeFallback() {
    document.getElementById(WIN_BAR_ID)?.remove();
    if (windowTimeTimer) { clearInterval(windowTimeTimer); windowTimeTimer = null; }
    if (!fallbackIframe) return;
    if (fallbackSavedStyle) {
      fallbackIframe.setAttribute('style', fallbackSavedStyle);
    } else {
      fallbackIframe.removeAttribute('style');
    }
    fallbackIframe = null;
    fallbackSavedStyle = '';
  }

  async function exitNative() {
    if (!document.fullscreenElement) return;
    try { await document.exitFullscreen(); } catch (e) { /* 무시 */ }
  }

  // 진짜 전체화면 토글. 창 전체화면 중이면 진짜 전체화면으로 전환.
  // 사용자 제스처 유지를 위해 requestFullscreen 은 await 없이 먼저 호출해야 함.
  async function toggleNativeFullscreen() {
    if (document.fullscreenElement) {
      await exitNative();
      updateButtonState();
      return { ok: true, active: false };
    }
    const iframe = document.querySelector(IFRAME_SELECTOR);
    if (!iframe) return { ok: false, reason: 'no-iframe' };

    if (fallbackIframe) removeFallback();
    // iframe 만 감싼 부모가 있으면 그 부모를 전체화면으로 → 종료 예고 알림을 같은 영역에 띄울 수 있음
    // (iframe 을 다른 요소로 옮기면 VNC 연결이 다시 로드되므로 옮기지 않음)
    const parent = iframe.parentElement;
    const target = parent && parent !== document.body && parent.childElementCount === 1 ? parent : iframe;
    // 일부 환경(임베디드 브라우저 등)에서는 promise 가 끝나지 않으므로 타임아웃으로 대체
    const request = target.requestFullscreen();
    const timeout = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('requestFullscreen timeout')), 1500));
    try {
      await Promise.race([request, timeout]);
    } catch (err) {
      if (!document.fullscreenElement) {
        console.warn('[ncloud-ext] Fullscreen API 실패, 창 전체화면으로 대체:', err);
        applyFallback(iframe);
        // 늦게라도 진짜 전체화면이 되면 창 전체화면은 해제
        request.then(() => {
          if (document.fullscreenElement) { removeFallback(); updateButtonState(); }
        }, () => {});
      }
    }
    updateButtonState();
    return { ok: true, active: true };
  }

  // 브라우저 창 전체화면(CSS) 토글. 진짜 전체화면 중이면 창 전체화면으로 전환.
  async function toggleWindowFullscreen() {
    if (fallbackIframe) {
      removeFallback();
      updateButtonState();
      return { ok: true, active: false };
    }
    const iframe = document.querySelector(IFRAME_SELECTOR);
    if (!iframe) return { ok: false, reason: 'no-iframe' };

    await exitNative();
    applyFallback(iframe);
    updateButtonState();
    return { ok: true, active: true };
  }

  document.addEventListener('fullscreenchange', updateButtonState);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && fallbackIframe) {
      removeFallback();
      updateButtonState();
    }
  });

  // ---------- 주입 UI ----------
  function createIcon(paths) {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', '16');
    svg.setAttribute('height', '16');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    svg.style.display = 'block';
    for (const d of paths) {
      const p = document.createElementNS(NS, 'path');
      p.setAttribute('d', d);
      svg.appendChild(p);
    }
    return svg;
  }

  function renderIconButton(btn, active, enterIcon, exitIcon, enterLabel, exitLabel) {
    const label = active ? exitLabel : enterLabel;
    btn.replaceChildren(createIcon(active ? exitIcon : enterIcon));
    btn.title = label;
    btn.setAttribute('aria-label', label);
    btn.setAttribute('aria-pressed', String(active));
    btn.dataset.active = String(active);
    btn.style.backgroundColor = active ? COLOR_ACTIVE : COLOR_IDLE;
  }

  function updateButtonState() {
    const fsBtn = document.getElementById(FS_BTN_ID);
    if (fsBtn) {
      renderIconButton(fsBtn, !!document.fullscreenElement,
        ICONS.screenEnter, ICONS.screenExit, '전체화면 (모니터 전체)', '전체화면 종료');
    }
    const winBtn = document.getElementById(WIN_BTN_ID);
    if (winBtn) {
      renderIconButton(winBtn, !!fallbackIframe,
        ICONS.windowEnter, ICONS.windowExit, '브라우저 창 전체화면', '창 전체화면 종료 (Esc)');
    }
  }

  // 자동연장 토글 스위치: "자동연장 (●   )" / "자동연장 (   ●)"
  function updateAutoExtendText() {
    const el = document.getElementById(AUTO_TEXT_ID);
    if (!el) return;
    const on = autoExtendEnabled;
    const label = on ? '자동 연장 켜짐 (최대 20분) - 클릭하여 끄기' : '자동 연장 꺼짐 - 클릭하여 켜기';
    el.setAttribute('aria-checked', String(on));
    el.title = label;
    const track = el.querySelector('[data-part="track"]');
    const knob = el.querySelector('[data-part="knob"]');
    if (track) track.style.backgroundColor = on ? COLOR_IDLE : '#9e9e9e';
    if (knob) knob.style.transform = on ? 'translateX(16px)' : 'translateX(0)';
  }

  function createAutoExtendSwitch(cs) {
    const sw = document.createElement('button');
    sw.type = 'button';
    sw.id = AUTO_TEXT_ID;
    sw.setAttribute('role', 'switch');
    Object.assign(sw.style, {
      display: 'inline-flex',
      alignItems: 'center',
      gap: '6px',
      verticalAlign: 'middle',
      marginRight: '8px',
      padding: '0 2px',
      border: 'none',
      background: 'transparent',
      color: '#333',
      cursor: 'pointer',
      fontSize: cs.fontSize,
      fontFamily: cs.fontFamily,
      fontWeight: 'bold',
    });

    const text = document.createElement('span');
    text.textContent = '자동연장';

    const track = document.createElement('span');
    track.dataset.part = 'track';
    Object.assign(track.style, {
      position: 'relative',
      display: 'inline-block',
      flex: 'none',
      width: '34px',
      height: '18px',
      borderRadius: '9px',
      transition: 'background-color 0.15s',
    });

    const knob = document.createElement('span');
    knob.dataset.part = 'knob';
    Object.assign(knob.style, {
      position: 'absolute',
      top: '2px',
      left: '2px',
      width: '14px',
      height: '14px',
      borderRadius: '50%',
      backgroundColor: 'white',
      boxShadow: '0 1px 2px rgba(0,0,0,0.3)',
      transition: 'transform 0.15s',
    });

    track.appendChild(knob);
    sw.append(text, track);
    sw.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      setAutoExtend(!autoExtendEnabled);
    });
    return sw;
  }

  // 20분 종료 예고 on/off 종 아이콘 (켜짐: 녹색, 꺼짐: 회색 + 사선)
  function updateBellButton() {
    const btn = document.getElementById(BELL_BTN_ID);
    if (!btn) return;
    const on = endWarningEnabled;
    const icon = createIcon(on ? ICONS.bellOn : ICONS.bellOff);
    // 켜짐: 종 몸통을 채워서 옆의 전체화면 아이콘(꽉 찬 녹색 버튼)과 무게감을 맞춤. 꺼짐: 회색 윤곽선 + 사선
    if (on) icon.firstChild.setAttribute('fill', 'currentColor');
    btn.replaceChildren(icon);
    btn.style.color = on ? COLOR_IDLE : '#9e9e9e';
    btn.setAttribute('aria-pressed', String(on));
    const label = on ? '20분 종료 예고 켜짐 - 클릭하여 끄기' : '20분 종료 예고 꺼짐 - 클릭하여 켜기';
    btn.title = label;
    btn.setAttribute('aria-label', label);
  }

  function createBellButton(size) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.id = BELL_BTN_ID;
    Object.assign(btn.style, {
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      verticalAlign: 'middle',
      boxSizing: 'border-box',
      width: size,
      height: size,
      padding: '0',
      marginRight: '8px',
      border: 'none',
      background: 'transparent',
      cursor: 'pointer',
    });
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      endWarningEnabled = !endWarningEnabled;
      updateBellButton();
      renderEndWarning();
      try { chrome.storage.sync.set({ [END_WARNING_KEY]: endWarningEnabled }); } catch (err) { /* 무시 */ }
    });
    return btn;
  }

  function removeInjectedUi() {
    document.getElementById(FS_BTN_ID)?.remove();
    document.getElementById(WIN_BTN_ID)?.remove();
    document.getElementById(AUTO_TEXT_ID)?.remove();
    document.getElementById(BELL_BTN_ID)?.remove();
  }

  function createIconButton(id, size, radius, onToggle) {
    const btn = document.createElement('button');
    btn.type = 'button'; // form 안에서 submit 되지 않도록
    btn.id = id;
    Object.assign(btn.style, {
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      verticalAlign: 'middle',
      boxSizing: 'border-box',
      width: size,
      height: size,
      padding: '0',
      borderRadius: radius,
      border: 'none',
      color: 'white',
      cursor: 'pointer',
      marginRight: '6px',
    });
    btn.addEventListener('mouseenter', () => {
      btn.style.backgroundColor = btn.dataset.active === 'true' ? COLOR_ACTIVE_HOVER : COLOR_IDLE_HOVER;
    });
    btn.addEventListener('mouseleave', updateButtonState);
    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const res = await onToggle();
      if (!res.ok) alert('Naver Cloud Console iframe을 찾을 수 없습니다.');
    });
    return btn;
  }

  function ensureInjectedUi(extendButton) {
    // 서버 접속 콘솔 기능을 끄면 추가 UI 를 하나도 넣지 않음 (원래 "연장" 버튼만)
    if (!consoleFeaturesEnabled) {
      removeInjectedUi();
      return;
    }
    // 기대하는 배치: [진짜 전체화면][창 전체화면] 자동연장 (●   ) [종] [연장]
    const wanted = [FS_BTN_ID, WIN_BTN_ID, AUTO_TEXT_ID, BELL_BTN_ID];
    const inPlace = wanted.every((id, i) => {
      const el = document.getElementById(id);
      return el && el.parentNode === extendButton.parentNode &&
        (i === 0 || el.previousElementSibling?.id === wanted[i - 1]);
    });
    if (inPlace) return;
    removeInjectedUi();

    const cs = window.getComputedStyle(extendButton);
    const h = parseFloat(cs.height);
    const size = (h >= 20 && h <= 48 ? h : 28) + 'px'; // 연장 버튼 높이에 맞춘 정사각형

    const btn = createIconButton(FS_BTN_ID, size, cs.borderRadius, toggleNativeFullscreen);
    const winBtn = createIconButton(WIN_BTN_ID, size, cs.borderRadius, toggleWindowFullscreen);
    extendButton.parentNode.insertBefore(btn, extendButton);
    extendButton.parentNode.insertBefore(winBtn, extendButton);
    extendButton.parentNode.insertBefore(createAutoExtendSwitch(cs), extendButton);
    extendButton.parentNode.insertBefore(createBellButton(size), extendButton);
    updateBellButton();

    updateButtonState();
    updateAutoExtendText();
  }

  // ---------- 탭 제목(서비스명) + 파비콘(리전 아이콘) ----------
  // 고정 규칙표 없이 콘솔 자체 데이터를 사용:
  //  1) 왼쪽 메뉴(LNB)에서 선택된 항목 이름 (예: "Subnet Management")
  //  2) 콘솔 메뉴 데이터 __CONSOLE_NUXT_DATA__ 의 경로 → 서비스명 (가장 긴 경로 일치, 없으면 첫 경로 세그먼트 일치)
  // 리전 아이콘은 헤더 리전 선택기 아이콘(::before background-image)의 이미지 URL 을 파비콘으로 사용
  // 콘솔 서브도메인은 서비스에 따라 달라질 수 있음 (예: Neuro). 매칭된 NCP 도메인이면 모두 대상.
  // 메뉴 데이터·리전 선택기가 없는 페이지에서는 제목/아이콘을 건드리지 않음.
  const IS_CONSOLE_HOST = /(^|\.)(fin-|gov-)?ncloud\.com$/.test(location.hostname);
  const FAVICON_ID = 'ncloud-ext-region-favicon';
  const TITLE_MAX_OVERRIDES = 10;          // 다른 확장/스크립트와 제목 다툼 방지
  const TITLE_OVERRIDE_WINDOW_MS = 10 * 1000;

  let menuMap = null;                      // Map<path, name>
  let pageCrumb = null;                    // { link, breadcrumb[] } : 서버가 렌더링한 현재 화면 정보
  let lastPath = null;
  let desiredTitle = null;
  let titleFinal = false;                  // 현재 경로의 최종 제목이 확정됐는지 (breadcrumb 기준)
  let settingsLoaded = false;              // 설정을 읽기 전에는 제목을 바꾸지 않음 (기능 꺼짐일 수 있으므로)
  let titleCache = {};                     // path → 제목 (재방문 시 페이지 로딩 전에 바로 표시)
  const TITLE_CACHE_KEY = 'titleCacheV2';   // V2: 서비스명이 빠진 제목이 저장되던 이전 캐시는 버림
  const TITLE_CACHE_MAX = 300;
  let titleOverrides = [];
  let titleFightLogged = false;
  let lastFaviconUrl = null;
  let pageTitle = null;                    // 콘솔이 원래 설정한 제목 (기능 끌 때 복원)
  const removedIcons = [];                 // 콘솔 원래 파비콘 링크 (기능 끌 때 복원)

  function loadMenuMap() {
    if (menuMap) return menuMap;
    // 페이지 로딩 중에는 데이터 태그가 아직 없거나 덜 받아졌을 수 있으므로, 성공했을 때만 캐시
    const el = document.getElementById('__CONSOLE_NUXT_DATA__');
    if (!el) return new Map();
    let data;
    try { data = JSON.parse(el.textContent); } catch (e) { return new Map(); }
    if (!Array.isArray(data)) return new Map();
    menuMap = new Map();

    // Nuxt payload 는 값이 배열 인덱스로 참조됨
    const resolve = (v) => (Number.isInteger(v) ? data[v] : v);
    const str = (v) => { const x = resolve(v); return typeof x === 'string' ? x : null; };
    const isObj = (x) => x && typeof x === 'object' && !Array.isArray(x);
    const add = (nameRef, urlRef) => {
      const name = str(nameRef)?.replace(/\s+/g, ' ').trim();
      let url = str(urlRef);
      if (!name || !url || !url.startsWith('/') || /^\/\d+(\/\d+)*$/.test(url)) return; // 숫자 경로 = 메뉴 그룹 노드
      try { url = new URL(url, location.origin).pathname; } catch (e) { return; }
      if (!menuMap.has(url)) menuMap.set(url, name);
    };

    for (const e of data) {
      if (isObj(e) && 'menuName' in e && 'menuUrl' in e) add(e.menuName, e.menuUrl);
    }
    const store = data.find((e) => isObj(e) && 'productList' in e);
    // 현재 화면의 breadcrumb (예: ["VPC", "Subnet Management"]) 와 그 화면 경로
    if (store && 'breadcrumb' in store) {
      const crumb = resolve(store.breadcrumb);
      const link = str(store.productLink);
      if (Array.isArray(crumb) && link) {
        const names = crumb.map((c) => str(c)?.replace(/\s+/g, ' ').trim()).filter(Boolean);
        if (names.length) pageCrumb = { link, breadcrumb: names };
      }
    }
    const categories = store && resolve(store.productList);
    if (Array.isArray(categories)) {
      for (const c of categories) {
        const products = resolve(resolve(c)?.products);
        if (!Array.isArray(products)) continue;
        for (const p of products) {
          const product = resolve(p);
          if (isObj(product)) add(product.name, product.link);
        }
      }
    }
    return menuMap;
  }

  function nameFromMenuData(path) {
    const map = loadMenuMap();
    let best = null;
    for (const [url, name] of map) {
      if ((path === url || path.startsWith(url.endsWith('/') ? url : url + '/')) &&
          (!best || url.length > best.url.length)) {
        best = { url, name };
      }
    }
    if (best) return best.name;
    // 하위 화면(예: /vpc-load-balancer/targetGroup) → 같은 서비스(첫 세그먼트)의 이름
    const seg = path.split('/')[1];
    if (!seg) return null;
    for (const [url, name] of map) {
      if (url.split('/')[1] === seg) return name;
    }
    return null;
  }

  function nameFromLnb() {
    const items = document.querySelectorAll('.lnb li.active.sort-item');
    const li = items[items.length - 1];
    if (!li) return null;
    const label = li.querySelector('a, span') || li;
    const text = (label.textContent || '').replace(/\s+/g, ' ').trim();
    return text && text.length <= 60 ? text : null;
  }

  // 탭 폭이 좁으므로 긴 서비스명은 축약 (키는 소문자, 정리된 이름 기준)
  const SERVICE_ABBR = {
    'papago translation': 'Papago',
    'ml expert platform': 'MLXP',
    'clova speech recognition (csr)': 'CSR',
    'simple & easy notification service': 'SENS',
    'ncloud simple rabbitmq': 'RabbitMQ',
    'search engine service': 'Search Engine',
    'cloud data streaming service': 'CDSS',
    'ncloud kubernetes service': 'NKS',
    'container registry': 'NCR',
    'database migration service': 'DMS',
    'effective log search & analytics': 'ELSA',
    'web service monitoring system': 'WMS',
    'cloud log analytics': 'CLA',
    'cloud activity tracer': 'CAT',
    'cloud insight (monitoring)': 'Cloud Insight',
    'pinpoint cloud': 'Pinpoint',
    'ncloud single sign-on': 'SSO',
    'notification recipient': 'Noti Recipient',
    'b2b prism live studio': 'PRISM Live',
    'video player enhancement': 'VPE',
    'one click multi drm': 'Multi DRM',
    'media connect center': 'Media Connect',
    'global traffic manager': 'GTM',
    'web security checker': 'Web Sec Checker',
    'system security checker': 'Sys Sec Checker',
    'key management service': 'KMS',
    'certificate manager': 'Cert Manager',
    'webshell behavior detector': 'WebShell Detector',
    'cloud security watcher': 'Security Watcher',
    'db & server access control': 'DB/Server Access',
  };

  function abbreviateService(name) {
    if (!name) return name;
    let n = name
      .replace(/\s+/g, ' ')
      .replace(/\s*\((deprecated|new|beta)\)\s*$/i, '') // 상태 표시 제거
      .replace(/\s+update$/i, '')                         // 메뉴의 "Update" 배지 텍스트
      .trim();
    const mapped = SERVICE_ABBR[n.toLowerCase()];
    if (mapped) return mapped;
    // Cloud DB for PostgreSQL → CDB PostgreSQL, Cloud DB Serverless → CDB Serverless
    n = n.replace(/^Cloud DB (for )?/i, 'CDB ');
    return n;
  }

  // "화면 - 서비스" (예: "Monitoring - CDB PostgreSQL")
  // 둘이 같거나 한쪽이 다른 쪽을 포함하면 하나만 (예: "Server" / "Server")
  function composeTitle(screen, service) {
    const short = abbreviateService(service);
    if (!screen) return short || null;
    if (!short) return screen;
    const a = screen.toLowerCase();
    // 원래 이름과 축약 이름 모두와 비교 (예: 화면 "Container Registry" + 서비스 "NCR" → 화면만)
    for (const b of [service.toLowerCase(), short.toLowerCase()]) {
      if (a === b || a.includes(b) || b.includes(a)) return screen;
    }
    return screen + ' - ' + short;
  }

  // 서버가 렌더링한 breadcrumb 이 현재 경로의 것이면 최종 제목을 바로 확정 (LNB 렌더링을 기다리지 않음)
  function titleFromBreadcrumb(path) {
    loadMenuMap();
    if (!pageCrumb) return null;
    const link = pageCrumb.link;
    if (!(path === link || path.startsWith(link.endsWith('/') ? link : link + '/'))) return null;
    const crumb = pageCrumb.breadcrumb;
    return composeTitle(crumb[crumb.length - 1], crumb[0]);
  }

  function rememberTitle(path, title) {
    if (titleCache[path] === title) return;
    titleCache[path] = title;
    const keys = Object.keys(titleCache);
    if (keys.length > TITLE_CACHE_MAX) {
      for (const k of keys.slice(0, keys.length - TITLE_CACHE_MAX)) delete titleCache[k];
    }
    try { chrome.storage.local.set({ [TITLE_CACHE_KEY]: titleCache }); } catch (e) { /* 무시 */ }
  }

  // 제목 결정 순서 (중간 단계 제목으로 여러 번 바뀌지 않도록):
  //  1) breadcrumb (최종)
  //  2) 왼쪽 메뉴 + 메뉴 데이터의 서비스명 (둘 다 있을 때만 최종)
  //     - 왼쪽 메뉴는 서버가 HTML 에 미리 그려 두지만 메뉴 데이터는 HTML 끝에서 도착하므로,
  //       서비스명을 모르는 상태로 확정하지 않음 (확정하면 "DB Server" 처럼 서비스명이 빠짐)
  //     - 페이지 로딩이 끝났는데도 서비스명이 없으면 화면 이름만으로 확정
  //  3) 이전 방문 때 저장한 제목 (임시)  4) 메뉴 데이터의 서비스명만 (임시)
  function resolveTitle(path) {
    const fromCrumb = titleFromBreadcrumb(path);
    if (fromCrumb) return { title: fromCrumb, final: true };
    const service = nameFromMenuData(path);
    const lnb = nameFromLnb();
    if (lnb) {
      if (service) return { title: composeTitle(lnb, service), final: true };
      if (document.readyState === 'complete') return { title: lnb, final: true };
    }
    if (titleCache[path]) return { title: titleCache[path], final: false };
    if (service && !lnb) return { title: composeTitle(null, service), final: false };
    return null;
  }

  function updateTitle() {
    if (!settingsLoaded) return;
    const path = location.pathname;
    if (path !== lastPath) {
      lastPath = path;
      desiredTitle = null;
      titleFinal = false;
    }
    if (!titleFinal) {
      const r = resolveTitle(path);
      if (r) {
        desiredTitle = r.title;
        titleFinal = r.final;
        if (r.final) rememberTitle(path, r.title);
      }
    }
    if (!desiredTitle || document.title === desiredTitle) return;

    const now = performance.now();
    titleOverrides = titleOverrides.filter((t) => now - t < TITLE_OVERRIDE_WINDOW_MS);
    if (titleOverrides.length >= TITLE_MAX_OVERRIDES) {
      if (!titleFightLogged) {
        console.warn('[ncloud-ext] 다른 확장이 탭 제목을 계속 바꾸고 있어 제목 변경을 잠시 멈춥니다 (NCP Tab Renamer 등 비활성화 권장)');
        titleFightLogged = true;
      }
      return;
    }
    titleOverrides.push(now);
    pageTitle = document.title; // 덮어쓰기 직전 값 = 콘솔이 설정한 제목
    console.debug('[ncloud-ext] title', JSON.stringify(pageTitle), '→', JSON.stringify(desiredTitle),
                  titleFinal ? '(final)' : '(provisional)', Math.round(performance.now()) + 'ms');
    document.title = desiredTitle;
  }

  function currentRegionIconUrl() {
    const toggle = [...document.querySelectorAll('.region-select .dropdown-toggle')]
      .find((t) => t.querySelector('.region'));
    if (!toggle) return null;
    for (const el of toggle.querySelectorAll('.region, .region *')) {
      const bg = window.getComputedStyle(el, '::before').backgroundImage;
      const m = bg && bg.match(/url\(["']?([^"')]+)["']?\)/);
      if (m) return m[1];
    }
    return null;
  }

  function updateFavicon() {
    const url = currentRegionIconUrl();
    if (!url) return;
    // 콘솔이 SPA 이동 중 파비콘 링크를 다시 넣을 수 있으므로 매번 확인
    const others = [...document.querySelectorAll('link[rel~="icon"]')].filter((l) => l.id !== FAVICON_ID);
    let link = document.getElementById(FAVICON_ID);
    if (link && link.isConnected && url === lastFaviconUrl && others.length === 0) return;
    others.forEach((l) => {
      if (!removedIcons.some((r) => r.href === l.href)) removedIcons.push(l.cloneNode());
      l.remove();
    });
    if (!link) {
      link = document.createElement('link');
      link.id = FAVICON_ID;
      link.rel = 'icon';
    }
    link.href = url;
    link.type = url.endsWith('.svg') ? 'image/svg+xml' : 'image/png';
    if (!link.isConnected) document.head.appendChild(link);
    lastFaviconUrl = url;
  }

  // 기능을 끄면 콘솔 원래 제목/파비콘으로 되돌림
  function restoreTabIdentity() {
    if (!IS_CONSOLE_HOST || !document.head) return;
    document.getElementById(FAVICON_ID)?.remove();
    const hasIcon = document.querySelector('link[rel~="icon"]');
    if (!hasIcon) removedIcons.forEach((l) => document.head.appendChild(l.cloneNode()));
    if (pageTitle !== null && document.title === desiredTitle) document.title = pageTitle;
    desiredTitle = null;
    titleFinal = false;
    lastPath = null;
    lastFaviconUrl = null;
  }

  function updateTabIdentity() {
    if (!IS_CONSOLE_HOST || !tabRenameEnabled) return;
    try {
      updateTitle();
      if (document.head) updateFavicon();
    } catch (e) {
      console.warn('[ncloud-ext] 탭 제목/아이콘 갱신 실패:', e);
    }
  }

  // DOM 변경 직후(화면 그리기 전) 동기 호출: 콘솔이 제목을 바꾸면 바로 되돌리고,
  // 아직 최종 제목이 없으면 데이터가 도착했는지 확인
  function onMutationsForTitle() {
    if (!IS_CONSOLE_HOST || !tabRenameEnabled || !settingsLoaded) return;
    if (titleFinal && location.pathname === lastPath && document.title === desiredTitle) return;
    updateTitle();
  }

  // ---------- 메인 루프 ----------
  function tick() {
    updateTabIdentity();
    const extendButton = findExtendButton();
    if (!extendButton) {
      removeInjectedUi();
      if (fallbackIframe && !fallbackIframe.isConnected) removeFallback();
      resetSessionState();
      return;
    }
    ensureInjectedUi(extendButton);
    maybeAutoExtend(extendButton, readTimes(extendButton));
  }

  function scheduleTick() {
    if (mutationTimer) return;
    mutationTimer = setTimeout(() => {
      mutationTimer = null;
      tick();
    }, 200);
  }

  function start() {
    // document_start 에 주입됨: 페이지 HTML 이 들어오는 동안의 변경도 감시
    new MutationObserver(() => {
      onMutationsForTitle();
      scheduleTick();
    }).observe(document.documentElement, {
      childList: true,
      subtree: true,
    });
    setInterval(tick, TICK_INTERVAL_MS);
    window.addEventListener('popstate', scheduleTick);
    window.addEventListener('load', scheduleTick); // 로딩 완료 후 아직 확정 못 한 제목 마무리
    loadSettings();
    tick();
  }

  start();
})();
