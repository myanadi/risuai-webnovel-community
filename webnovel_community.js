//@name Webnovel_Serial_v0.1.0
//@display-name 웹소커뮤
//@api 3.0
//@version 0.1.0
//@arg foreshadow_mode string 떡밥 추출: combined(1회·기본) 또는 split(2회·정확)
//@arg body_mode string 회차 본문 저장: summary(요약·기본) 또는 full(전체)
//@arg comment_count int 회차당 댓글 수 (3~20, 기본 8)
//@arg board_post_count int 게시판 글 수 (3~15, 기본 6)
//@arg auto_close int 자동 마감: 0(끔·기본) 또는 1(켬)
//@arg use_hypa int 하이파 배경맥락: 0(끔·기본) 또는 1(켬)
//@arg mood_bias int 분위기 보정 (-50~+50, 기본 0. 음수=싸늘, 양수=우호)
//@arg use_regulars int 단골 기억: 0(끔) 또는 1(켬·기본)
//@arg use_glossary int 용어 적립: 0(끔) 또는 1(켬·기본)
//@arg comment_model string 댓글 모델: submodel(보조·기본) 또는 model(일반)
//@arg flame_cap int 악플 수위 상한 (1~5, 기본 3. 높을수록 거칠어짐)
//@arg allow_nsfw int NSFW 허용: 0(끔·기본) 또는 1(켬)

(async () => {
  'use strict';

  // ===========================================================================
  // 0. 상수 / 전역 톤
  // ===========================================================================

  const SCHEMA_VERSION = 1;

  // 현재 캐릭터 인덱스를 prefix로 박아 캐릭터별로 강제 분리.
  // (pluginStorage의 세이브 단위가 캐릭터 단위와 다를 수 있어서 안전장치)
  async function cid() {
    try {
      const i = await risuai.getCurrentCharacterIndex();
      return Number.isFinite(i) ? `c${i}:` : 'c?:';
    } catch { return 'c?:'; }
  }
  async function chid() {
    try {
      const i = await risuai.getCurrentChatIndex();
      return Number.isFinite(i) ? `chat${i}:` : 'chat?:';
    } catch { return 'chat?:'; }
  }
  const K = {
    core: async () => (await cid()) + (await chid()) + 'serial:core',
    index: async () => (await cid()) + (await chid()) + 'serial:index',
    ch: async (n) => (await cid()) + (await chid()) + `serial:ch:${n}`,
    board: async (type) => (await cid()) + (await chid()) + `serial:board:${type}`,
    author: async () => (await cid()) + (await chid()) + 'serial:author',
    settings: 'serial:settings', // 설정은 캐릭터·채팅 안 가리고 전역 유지
  };
  const BOARD_TYPES = ['discuss', 'foreshadow', 'chitchat']; // 전개토론 / 떡밥물기 / 잡담겟
  const BOARD_LABEL = { discuss: '전개·토론', foreshadow: '떡밥물기', chitchat: '잡담겟' };
  const ALL_CHIPS = ['author', 'discuss', 'foreshadow', 'chitchat']; // 칩 순서(작가의 말 먼저)
  const CHIP_LABEL = { author: '작가의 말', ...BOARD_LABEL };

  // 평판(hype 0~100)에 수동 보정(moodBias -50~+50)을 더해 분위기 점수(0~100)를 낸다.
  // 그 점수를 LLM이 알아듣는 "분위기 지시 문구"로 환산. (B: 평판→프롬프트 연결)
  function moodDirective(core, cfg) {
    const base = (core.reputation && core.reputation.hype) ?? 50;
    const score = Math.max(0, Math.min(100, base + (cfg.moodBias || 0)));
    let tone;
    if (score >= 80) tone = '독자들이 완전히 달아올라 있다. 호평·영업·찬양이 주를 이루고, 비판은 거의 없다.';
    else if (score >= 60) tone = '분위기가 대체로 우호적이다. 호평이 많지만 가벼운 지적도 섞인다.';
    else if (score >= 40) tone = '호불호가 갈린다. 호평과 비판이 비슷하게 섞이고 논쟁적이다.';
    else if (score >= 20) tone = '분위기가 식었다. 실망·비판·불만 댓글 비중이 높고, 호평은 소수다.';
    else tone = '분위기가 싸늘하다. 혹평·손절 선언·성토가 주를 이루고, 옹호는 드물다.';
    return { score, tone };
  }

  // 댓글/게시판 생성 모드 기본값. 설정 comment_model로 덮어씀(submodel/model).
  // submodel = 보조모델(저렴), model = 일반(메인) 모델.
  const LLM_MODE_DEFAULT = 'submodel';

  // 모든 생성 패스 상단에 공통 주입되는 전역 톤. (명세 0번)
  const TONE = [
    '너는 여성향 웹소설 연재 플랫폼의 독자들이다.',
    '독자는 사실상 전원 여성이며, 자연스러운 여초 커뮤니티/트위터 말투를 쓴다.',
    '반드시 한국어로만 쓴다. 영어 문장이나 영어 분석 리포트体를 절대 쓰지 않는다.',
    '댓글/글의 text, title 등 모든 출력 내용은 한국어다. (JSON 키 이름만 영어)',
    '금지: 희화화된 여성 말투("어머어머"), 남초 커뮤 말투(~노/~누/ㅇㅈ 등),',
    '      의미 없는 비명, 하트·이모티콘 도배.',
    '지향: 정주행·박제·입덕·손절·최애/차애·영업·커플링 등 실제 덕질 표현.',
    '      화력 있고 똑똑하게. 좋으면 미친 듯 영업하고 별로면 칼같이 깐다.',
    '커플링명·밈·드립은 너희가 알아서 자생적으로 만든다(미리 주어지지 않음).',
    '단, 이미 정해진 용어(아래 용어집)가 있으면 반드시 그것을 일관되게 재사용한다.',
  ].join('\n');

  // ===========================================================================
  // 1. 설정 읽기 (getArgument 래퍼 + 기본값)
  // ===========================================================================

  async function settings() {
    const overrides = await load(K.settings, {});
    const arg = async (key) => overrides[key] !== undefined ? overrides[key] : await risuai.getArgument(key);

    const num = (v, def, lo, hi) => {
      const n = parseInt(v, 10);
      if (isNaN(n)) return def;
      return Math.max(lo, Math.min(hi, n));
    };
    return {
      foreshadowMode: (await arg('foreshadow_mode')) || 'combined',
      bodyMode: (await arg('body_mode')) || 'summary',
      commentCount: num(await arg('comment_count'), 8, 3, 20),
      boardPostCount: num(await arg('board_post_count'), 6, 3, 15),
      autoClose: String(await arg('auto_close')) === '1',
      useHypa: String(await arg('use_hypa')) === '1',
      moodBias: num(await arg('mood_bias'), 0, -50, 50),
      useRegulars: String(await arg('use_regulars') ?? '1') !== '0',
      useGlossary: String(await arg('use_glossary') ?? '1') !== '0',
      commentModel: (await arg('comment_model')) || LLM_MODE_DEFAULT,
      flameCap: num(await arg('flame_cap'), 3, 1, 5),
      allowNsfw: String(await arg('allow_nsfw')) === '1',
    };
  }

  // ===========================================================================
  // 2. 저장소 (pluginStorage를 JSON 래퍼로. 세이브별·기기간 동기화)
  // ===========================================================================

  async function load(key, fallback) {
    try {
      const raw = await risuai.pluginStorage.getItem(key);
      if (raw == null) return fallback;
      return typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch (e) {
      console.error('[serial] load 실패', key, e);
      return fallback;
    }
  }
  async function save(key, value) {
    try {
      await risuai.pluginStorage.setItem(key, JSON.stringify(value));
    } catch (e) {
      console.error('[serial] save 실패', key, e);
    }
  }

  function freshCore() {
    return {
      schemaVersion: SCHEMA_VERSION,
      lastClosedCount: 0, // 마지막 마감 시점의 메시지 개수 (다음 수집 시작 인덱스)
      chapterCount: 0,
      readers: [],           // { id, handle, persona, memory, affinity }
      ledger: [],            // { id, text, openedAt, status:'open'|'promised'|'closed', note }
      glossary: [],          // { term, meaning, firstSeen }
      reputation: { hype: 50, anti: 0 },
    };
  }
  const loadCore = async () => load(await K.core(), freshCore());
  const saveCore = async (core) => save(await K.core(), core);

  // ===========================================================================
  // 3. LLM 호출 공통 + JSON 파싱
  // ===========================================================================

  async function callLLM(systemText, userText, mode = LLM_MODE_DEFAULT) {
    const messages = [
      { role: 'system', content: systemText },
      { role: 'user', content: userText },
    ];
    let res;
    try {
      res = await risuai.runLLMModel({ messages, mode });
    } catch (e) {
      // 429(rate limit) 등 일시적 오류면 잠깐 쉬고 한 번 더.
      const msg = String(e && e.message || e);
      if (/429|rate|limit|too many/i.test(msg)) {
        await new Promise((r) => setTimeout(r, 2500));
        try {
          res = await risuai.runLLMModel({ messages, mode });
        } catch (e2) {
          console.error('[serial] runLLMModel 재시도도 실패:', e2);
          throw e2;
        }
      } else {
        // 호출 자체가 실패하면 mode 값이 안 맞을 가능성. (설정 comment_model을 'model'로 바꿔 테스트)
        console.error('[serial] runLLMModel 실패 — comment_model 확인 필요:', e);
        throw e;
      }
    }
    if (res == null) return '';
    if (typeof res === 'string') return res;

    // 스트림(ReadableStream<string>) 반환이면 끝까지 읽어 합친다.
    if (typeof res.getReader === 'function') {
      const reader = res.getReader();
      let out = '';
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        out += typeof value === 'string' ? value : '';
      }
      return out;
    }

    // 객체로 감싸 오는 경우: { content }, { success, content }, { message }, { data } 등.
    if (typeof res === 'object') {
      const cand = res.content ?? res.message ?? res.text ?? res.data ?? res.result;
      if (typeof cand === 'string') return cand;
      // content가 또 스트림/객체일 수 있음
      if (cand && typeof cand.getReader === 'function') {
        const reader = cand.getReader();
        let out = '';
        while (true) { const { value, done } = await reader.read(); if (done) break; out += typeof value === 'string' ? value : ''; }
        return out;
      }
      // 어떤 필드에 들었는지 모를 때를 위한 진단(한 번 보고 필드 고정).
      console.warn('[serial] LLM 응답이 객체 — 구조 확인용 덤프:', res);
      if (cand != null) return String(cand);
    }
    return String(res);
  }

  // 모델이 코드펜스/잡설/뒤따르는 설명을 붙여도 JSON만 안전 추출.
  function parseJSON(text, fallback) {
    if (typeof text !== 'string' || !text.trim()) {
      console.warn('[serial] parseJSON: 빈 입력', text);
      return fallback;
    }
    let s = text.replace(/```json/gi, '').replace(/```/g, '').trim();

    // 1차: 통째로 시도
    try { return JSON.parse(s); } catch (_) {}

    // 2차: 첫 여는 괄호부터 짝이 맞는 닫는 괄호까지 정확히 잘라 시도
    const open = (() => {
      const o = s.indexOf('{'), a = s.indexOf('[');
      if (o === -1) return a; if (a === -1) return o; return Math.min(o, a);
    })();
    if (open === -1) { console.warn('[serial] parseJSON: 괄호 없음', s.slice(0, 200)); return fallback; }

    const openCh = s[open], closeCh = openCh === '{' ? '}' : ']';
    let depth = 0, end = -1, inStr = false, esc = false;
    for (let i = open; i < s.length; i++) {
      const ch = s[i];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === openCh) depth++;
      else if (ch === closeCh) { depth--; if (depth === 0) { end = i; break; } }
    }
    const candidate = end !== -1 ? s.slice(open, end + 1) : s.slice(open);
    try {
      return JSON.parse(candidate);
    } catch (e) {
      console.warn('[serial] parseJSON 실패. 응답 앞부분:', candidate.slice(0, 300));
      return fallback;
    }
  }

  // ===========================================================================
  // 4. 회차 마감 — 오케스트레이터
  // ===========================================================================

  async function closeChapter() {
    const cfg = await settings();
    const core = await loadCore();

    // ① 회차 본문 수집 (공짜)
    const collected = await collectChapterText(core);
    const text = collected.text;
    if (!text || !text.trim()) {
      console.warn('[serial] 마감할 새 본문이 없음');
      return;
    }

    // ② 맥락 조립 (공짜)
    const ctx = await buildContext(text, core, cfg);

    // ③ LLM 패스 (유일 비용) — 설정 토글로 1회/2회 분기
    let comments, diff, summary, regulars = [], newTerms = [];
    if (cfg.foreshadowMode === 'split') {
      comments = await genComments(ctx, cfg);
      const ex = await extractForeshadow(ctx);
      diff = ex.diff;
      summary = ex.summary;
    } else {
      const combined = await genCombined(ctx, cfg);
      comments = combined.comments;
      diff = combined.diff;
      summary = combined.summary;
      regulars = combined.regulars || [];
      newTerms = combined.glossary || [];
    }

    // ④ 결과 분기 저장 (공짜)
    const n = core.chapterCount + 1;
    await saveChapter(n, {
      title: ctx.title || `${n}화`,
      body: cfg.bodyMode === 'full' ? text : (summary || ''),
      comments,
    });
    if (cfg.useRegulars) updateReaders(core, regulars);
    updateLedger(core, diff);
    if (cfg.useGlossary) updateGlossary(core, newTerms);
    updateReputation(core, comments, cfg);

    core.chapterCount = n;
    core.lastClosedCount = collected.count;
    await saveCore(core);

    // ⑤ 표시
    renderComments(n);
  }

  // 작가의 말 게시판에 글 올리기 (양방향). 작가 글 저장 → 독자 댓글 LLM 생성.
  async function postAuthorMessage(textBody) {
    if (!textBody || !textBody.trim()) return;
    const cfg = await settings();
    const core = await loadCore();

    const replies = await genAuthorReplies(textBody, cfg);

    // 작가 글 + 독자 댓글을 저장 (최신이 위로)
    const store = await load(await K.author(), { posts: [] });
    store.posts.unshift({
      id: 'a_' + Math.random().toString(36).slice(2, 8),
      text: textBody,
      at: Date.now(),
      likes: Math.floor(replies.length * (3 + Math.random() * 5)),
      comments: replies,
    });
    await save(await K.author(), store);

    // 떡밥 '예고' 연결: 작가가 "곧 푼다/회수" 류 언급하면 열린 떡밥을 promised로.
    if (/곧|회수|풀|밝힐|밝혀|공개|떡밥/.test(textBody)) {
      let touched = false;
      for (const f of core.ledger) {
        if (f.status === 'open') { f.status = 'promised'; touched = true; }
      }
      if (touched) await saveCore(core);
    }
    // 소통은 호감에 약하게 +
    core.reputation = core.reputation || { hype: 50, anti: 0 };
    core.reputation.hype = Math.min(100, core.reputation.hype + 3);
    core.reputation.anti = 100 - core.reputation.hype;
    await saveCore(core);

    renderBoard('author');
  }

  // --- 회차 본문 수집 ---------------------------------------------------------
  // 현재 캐릭터/챗의 메시지 배열에서 lastClosedCount 이후만 잘라 한 화로 묶는다.
  // 반환: { text, count } — count는 이번에 본 전체 메시지 개수(다음 시작점).
  async function collectChapterText(core) {
    try {
      const ci = await risuai.getCurrentCharacterIndex();
      const chi = await risuai.getCurrentChatIndex();
      const chat = await risuai.getChatFromIndex(ci, chi);
      if (!chat) {
        console.warn('[serial] 현재 채팅을 읽지 못함 (DB 접근 동의 필요할 수 있음)');
        return { text: '', count: core.lastClosedCount };
      }

      // 리수 네이티브는 chat.message, 일부 경로는 chat.messages.
      const msgs = chat.message || chat.messages || [];
      const total = msgs.length;
      const start = Math.min(core.lastClosedCount || 0, total);
      const slice = msgs.slice(start);

      // 각 메시지: { role:'char'|'user'|..., data|content }
      const lines = [];
      for (const m of slice) {
        const body = (m && (m.data ?? m.content) || '').trim();
        if (!body) continue;
        const who = (m.role === 'user') ? '유저' : '서술';
        lines.push(`[${who}] ${body}`);
      }

      return { text: lines.join('\n\n'), count: total };
    } catch (e) {
      console.error('[serial] collectChapterText 실패', e);
      return { text: '', count: core.lastClosedCount };
    }
  }

  // --- 맥락 조립 (공짜) -------------------------------------------------------
  async function buildContext(text, core, cfg) {
    // 떡밥/단골/용어집을 프롬프트용 짧은 문자열로 직렬화.
    const openLedger = core.ledger
      .filter((f) => f.status !== 'closed')
      .map((f) => `- (${f.openedAt}화) ${f.text} [${f.status}]`)
      .join('\n');
    const glossary = core.glossary
      .map((g) => `- ${g.term}: ${g.meaning}`)
      .join('\n');
    const readers = core.readers
      .map((r) => `- ${r.handle}(${r.persona}): ${r.memory}`)
      .join('\n');

    let hypa = '';
    if (cfg.useHypa) {
      // 하이파가 켜져 있으면 beforeRequest 시점의 완성 프롬프트에서 배경요약을
      // 긁어와 얹는다(선택·보조). TODO: 캐시한 하이파 요약 참조.
      hypa = '';
    }

    const mood = moodDirective(core, cfg);

    return {
      body: text,
      openLedger,
      glossary,
      readers,
      hypa,
      mood,             // { score, tone } — B: 평판→프롬프트 연결
      flameCap: cfg.flameCap,
      allowNsfw: cfg.allowNsfw,
      title: '',        // TODO: 본문에서 회차 제목 추출하거나 비워둠
    };
  }

  // ===========================================================================
  // 5. LLM 패스들 (프롬프트 = 본인이 채울 핵심부)
  // ===========================================================================

  // 렌더가 쓰는 페르소나 뱃지와 일치시키는 집합. (null = 일회성 익명 독자)
  const PERSONAS = '광팬, 안티, 떡밥수집가, 손절러, 차애러, 일반';

  // LLM이 likes/replies를 안 줘도 렌더가 깨지지 않게 보정. best는 좋아요 최상위에 부여.
  function decorateComments(comments) {
    const arr = Array.isArray(comments) ? comments : [];
    let bestSet = arr.some((c) => c.best);
    const out = arr.map((c, i) => ({
      handle: c.handle || `익명${Math.floor(1000 + Math.random() * 9000)}`,
      readerId: c.readerId ?? null,
      persona: c.persona && c.persona !== '일반' ? c.persona : null,
      text: c.text || '',
      best: !!c.best,
      likes: Number.isFinite(c.likes) ? c.likes : Math.floor(Math.random() * 120) + (c.best ? 200 : 0),
      replies: Number.isFinite(c.replies) ? c.replies : Math.floor(Math.random() * 20),
    }));
    // best 표시가 하나도 없으면 좋아요 1위를 best로.
    if (!bestSet && out.length) {
      out.reduce((m, c) => (c.likes > m.likes ? c : m), out[0]).best = true;
    }
    return out;
  }

  function decoratePosts(posts) {
    const arr = Array.isArray(posts) ? posts : [];
    return arr.map((p) => ({
      handle: p.handle || `익명${Math.floor(1000 + Math.random() * 9000)}`,
      title: p.title || '(제목 없음)',
      text: p.text || '',
      likes: Number.isFinite(p.likes) ? p.likes : Math.floor(Math.random() * 150),
      replies: Number.isFinite(p.replies) ? p.replies : Math.floor(Math.random() * 40),
      comments: [], // 게시판 글 댓글은 추후 확장용 예약(㉡)
    }));
  }

  // 악플 수위(1~5)를 문구로.
  function flameDirective(cap) {
    const m = {
      1: '비판은 점잖고 예의 있게. 욕설·인신공격 금지.',
      2: '비판은 솔직하되 선을 지킨다. 가벼운 비꼼까지만.',
      3: '비판은 가감 없이. 비꼼·드립 허용하되 인신공격은 자제.',
      4: '신랄하게 까도 된다. 거친 표현·강한 비난 허용.',
      5: '악플도 가감 없이. 독설·조롱까지 허용(단 차별·혐오 표현은 제외).',
    };
    return m[cap] || m[3];
  }

  // 댓글 길이 다양성 — 4:4:2 비율 고정. 실제 웹소설 댓글창 분포.
  const LENGTH_MIX = [
    '댓글 길이는 의도적으로 다양하게 섞는다(매우 중요). 권장 비율:',
    '- 짧음 40% (한 줄 드립·짧은 호응, 예: "이거 진짜 미쳤다 ㅠㅠ")',
    '- 중간 40% (2~3문장, 가벼운 감상·지적·반응)',
    '- 긴 글 20% (4문장 이상의 분석·장문 감상·진심 토로). 보통 best 댓글이 여기 속함.',
    '모두 같은 길이로 쓰지 않는다. 짧은 것은 정말 짧게, 긴 것은 충분히 길게.',
  ].join('\n');

  function commentInstruction(cfg, ctx) {
    const lines = [
      TONE, '',
      `이번 회차를 읽은 독자 댓글을 ${cfg.commentCount}개 정도 생성한다.`,
      '단골 독자(아래 명단)는 자기 페르소나와 과거 기억에 맞게 반응하고,',
      '열린 떡밥을 알아채거나 추궁하는 댓글이 섞이면 좋다.',
      `persona는 다음 중 하나: ${PERSONAS}. (일회성 익명이면 "일반")`,
      '', LENGTH_MIX, '',
    ];
    if (ctx && ctx.mood) lines.push(`[분위기] ${ctx.mood.tone} 이 분위기를 댓글 비중에 반영한다.`);
    lines.push(`[수위] ${flameDirective(cfg.flameCap)}`);
    if (cfg.allowNsfw) lines.push('[수위] 성인 작품이므로 야한 전개에 대한 직접적 반응도 허용된다.');
    else lines.push('[수위] 과도하게 노골적인 성적 표현은 피한다.');
    lines.push(
      '가장 공감 많이 받을 댓글 하나에 best:true.',
      '출력은 JSON 배열만, 다른 말 금지:',
      '[{ "handle":"닉네임", "readerId":null, "persona":"광팬",',
      '   "text":"댓글 내용", "best":false }]'
    );
    return lines.join('\n');
  }

  function contextBlock(ctx) {
    return [
      ctx.hypa ? `[배경]\n${ctx.hypa}\n` : '',
      ctx.glossary ? `[팬덤 용어집(반드시 재사용)]\n${ctx.glossary}\n` : '',
      ctx.readers ? `[단골 독자]\n${ctx.readers}\n` : '',
      ctx.openLedger ? `[열린 떡밥]\n${ctx.openLedger}\n` : '',
      `[이번 회차]\n${ctx.body}`,
    ].filter(Boolean).join('\n');
  }

  // 통합 모드: 댓글 + 떡밥diff + 요약 + 단골후보 + 새용어를 한 번에
  async function genCombined(ctx, cfg) {
    const extra = [];
    if (cfg.useRegulars) {
      extra.push('"regulars": [{ "handle":"단골될만한 독자 닉", "persona":"광팬", "memo":"이 독자의 이번 반응 한 줄(기억용)" }]  // 인상적인 독자 0~3명');
    }
    if (cfg.useGlossary) {
      extra.push('"glossary": [{ "term":"커플링명/밈", "meaning":"뜻 한 줄" }]  // 이번 댓글에서 새로 생긴 용어만, 없으면 []');
    }
    const sys = [
      commentInstruction(cfg, ctx), '',
      '추가로 같은 JSON 안에 아래 항목들도 담는다. 최종 출력:',
      '{ "comments": [...위 형식...],',
      '  "diff": { "opened": [{"text","note"}], "closed": ["떡밥id"], "promised": ["떡밥id"] },',
      '  "summary": "이 회차 한 줄 요약"' + (extra.length ? ',' : ''),
      ...extra.map((e, i) => '  ' + e + (i < extra.length - 1 ? ',' : '')),
      '}',
    ].join('\n');
    const raw = await callLLM(sys, contextBlock(ctx), cfg.commentModel);
    const out = parseJSON(raw,
      { comments: [], diff: { opened: [], closed: [], promised: [] }, summary: '', regulars: [], glossary: [] });
    if (!out.comments || out.comments.length === 0) {
      console.warn('[serial] genCombined: 댓글 0개. 원본 응답:', raw);
    }
    out.comments = decorateComments(out.comments).slice(0, cfg.commentCount);
    return out;
  }

  // 분리 모드: 댓글만
  async function genComments(ctx, cfg) {
    const sys = commentInstruction(cfg, ctx);
    const out = decorateComments(parseJSON(await callLLM(sys, contextBlock(ctx), cfg.commentModel), []));
    return out.slice(0, cfg.commentCount);
  }

  // 분리 모드: 떡밥 추출 + 요약만
  async function extractForeshadow(ctx) {
    const sys = [
      '너는 웹소설 편집 보조다. 아래 회차에서 떡밥(미회수 복선)의 변화를 추적한다.',
      '요약기처럼 디테일을 버리지 말고, 사소해 보여도 미회수 실밥을 잡아낸다.',
      '출력 JSON만:',
      '{ "diff": { "opened": [{"text","note"}], "closed": ["떡밥id"], "promised": ["떡밥id"] },',
      '  "summary": "이 회차 한 줄 요약" }',
    ].join('\n');
    const out = parseJSON(await callLLM(sys, contextBlock(ctx)),
      { diff: { opened: [], closed: [], promised: [] }, summary: '' });
    return out;
  }

  // 게시판 글 — 마감과 분리. renderBoard의 새로고침이 호출.
  async function genBoardPosts(type, cfg) {
    const core = await loadCore();
    // 게시판별 렌즈(프롬프트 톤)가 다름.
    const lens = {
      discuss: '앞으로의 전개를 추리하거나 "이렇게 됐으면" 바라는 글이 섞이는 토론 게시판. 분석·추리·바람·읍소가 한 곳에 모인다. 일부는 냉정한 추리, 일부는 감정적 호소.',
      foreshadow: '미회수 복선을 건져오고 "왜 안 풀어주냐" 추궁하는 불만 톤. 떡밥 정리.txt 글이나 작가에게 따지는 글.',
      chitchat: '작품 얘기를 빌미로 한 덕질 일상·주접·트위터 감성. 작품과 직접 관련 없어 보여도 결국 다 작품 사랑. 결을 다양하게 섞을 것: (1) 주접/헌사("오늘도 빵나커플 생각하면서 출근함 작가님 절 살리셨어요"), (2) 생카·이벤트·공구 모집("주말에 빵나커플 생카 엽니다 5명 모집"), (3) 일상 트윗("꿈에 태경 나옴 ㅋㅋㅋㅋ"), (4) 짤·박제·명대사("33화 그 대사 폰배경 함"), (5) 영업·입덕썰("친구가 영업해서 정주행 밤샘"), (6) 커플링 진영 정모. 의미 0% 사랑 200%인 글이 많이 섞일수록 좋다.',
    }[type];
    const lengthHint = type === 'chitchat'
      ? '글 길이는 다양하게: 한 줄 트윗 같은 짧은 글부터 장문 헌사까지 섞는다. 짧은 글이 더 많아도 좋다.'
      : '호흡이 긴 글을 쓴다.';
    const sys = [
      TONE, '',
      `독자 게시판 글을 ${cfg.boardPostCount}개 생성한다. 게시판 성격: ${lens}`,
      `아래 회차 요약들을 근거로, ${lengthHint} title과 text 모두 한국어.`,
      '출력 JSON 배열만, 다른 말 금지: [{ "handle":"닉네임", "title":"제목", "text":"본문", "likes":0 }]',
    ].join('\n');

    // 최근 회차 요약을 근거 자료로 제공 (없으면 본문 일부라도).
    const index = await load(await K.index(), []);
    const recent = index.slice(0, 5); // 최신 5화
    const chapterLines = [];
    for (const it of recent) {
      const ch = await load(await K.ch(it.n), null);
      if (!ch) continue;
      const gist = ch.body && ch.body.length ? ch.body.slice(0, 300) : (ch.title || '');
      chapterLines.push(`- ${it.n}화「${ch.title || ''}」: ${gist}`);
    }

    const userBlock = [
      chapterLines.length ? `[최근 회차]\n${chapterLines.join('\n')}` : '',
      core.glossary.length ? `[용어집]\n${core.glossary.map(g => `- ${g.term}: ${g.meaning}`).join('\n')}` : '',
      core.ledger.filter(f => f.status !== 'closed').length
        ? `[열린 떡밥]\n${core.ledger.filter(f => f.status !== 'closed').map(f => `- (${f.openedAt}화) ${f.text}`).join('\n')}` : '',
    ].filter(Boolean).join('\n\n') || '(아직 자료 없음 — 일반적인 독자 잡담을 한국어로)';

    return decoratePosts(parseJSON(await callLLM(sys, userBlock, cfg.commentModel), [])).slice(0, cfg.boardPostCount);
  }

  // 작가의 말: 작가가 쓴 글에 독자 댓글 생성. (양방향의 '응답' 쪽)
  // 작가의 말 → 독자 반응. 평판/단골/떡밥 예고와 연결.
  async function genAuthorReplies(authorPost, cfg) {
    const core = await loadCore();
    const mood = moodDirective(core, cfg);
    const sys = [
      TONE, '',
      `작가가 올린 공지/소회 글에 대한 독자 댓글을 ${cfg.commentCount}개 정도 생성한다.`,
      '작가의 말에 직접 호응한다(공감·감사·항의·기대·드립 등).',
      LENGTH_MIX,
      `[분위기] ${mood.tone} 이 분위기를 반영한다.`,
      `[수위] ${flameDirective(cfg.flameCap)}`,
      core.readers.length ? `[단골 독자]\n${core.readers.map(r => `- ${r.handle}(${r.persona}): ${r.memory}`).join('\n')}` : '',
      '출력은 JSON 배열만: [{ "handle":"닉네임", "persona":"광팬", "text":"댓글", "best":false }]',
    ].filter(Boolean).join('\n');
    const out = decorateComments(parseJSON(await callLLM(sys, `[작가의 글]\n${authorPost}`, cfg.commentModel), []));
    return out.slice(0, cfg.commentCount);
  }

  // ===========================================================================
  // 6. 상태 갱신 (전부 공짜 — 저장/파생)
  // ===========================================================================

  async function saveChapter(n, { title, body, comments }) {
    await save(await K.ch(n), {
      n, title, body,
      views: Math.floor(8000 + Math.random() * 8000), // 공짜 양념
      rating: (9 + Math.random()).toFixed(1),
      comments,
    });
    const index = await load(await K.index(), []);
    index.unshift({ n, title, commentCount: comments.length });
    await save(await K.index(), index);
  }

  // 단골 기억: LLM이 뽑은 regulars 후보를 core.readers에 등록/누적.
  // regulars 항목: { handle, persona, memo }
  function updateReaders(core, regulars) {
    if (!Array.isArray(regulars) || !regulars.length) return;
    const MAX = 12; // 단골 명단 상한(프롬프트 비대 방지)
    for (const r of regulars) {
      if (!r || !r.handle) continue;
      const existing = core.readers.find((x) => x.handle === r.handle);
      if (existing) {
        // 기억 누적(최근 3개 줄만 유지)
        const lines = (existing.memory ? existing.memory.split(' / ') : []);
        if (r.memo) lines.push(r.memo);
        existing.memory = lines.slice(-3).join(' / ');
        if (r.persona) existing.persona = r.persona;
        existing.appearances = (existing.appearances || 1) + 1;
      } else {
        core.readers.push({
          id: 'r_' + Math.random().toString(36).slice(2, 8),
          handle: r.handle,
          persona: r.persona || '일반',
          memory: r.memo || '',
          appearances: 1,
        });
      }
    }
    // 너무 많으면 등장 잦은 순으로 상한 유지
    if (core.readers.length > MAX) {
      core.readers.sort((a, b) => (b.appearances || 0) - (a.appearances || 0));
      core.readers = core.readers.slice(0, MAX);
    }
  }

  function updateLedger(core, diff) {
    if (!diff) return;
    const genId = () => 'f_' + Math.random().toString(36).slice(2, 9);
    for (const o of (diff.opened || [])) {
      core.ledger.push({ id: genId(), text: o.text, openedAt: core.chapterCount + 1, status: 'open', note: o.note || '' });
    }
    for (const id of (diff.promised || [])) {
      const f = core.ledger.find((x) => x.id === id); if (f) f.status = 'promised';
    }
    for (const id of (diff.closed || [])) {
      const f = core.ledger.find((x) => x.id === id); if (f) f.status = 'closed';
    }
    mirrorLedgerToLorebook(core); // 로어북 조건부 주입용 미러
  }

  async function mirrorLedgerToLorebook(core) {
    // 열린 떡밥을 로어북 엔트리로 미러링 → RP 본편에서 해당 키워드 등장 시
    // "이 떡밥 아직 미회수"가 모델에 자동 상기됨.
    // TODO: getDatabase로 캐릭터 로어북 접근 → serial 전용 엔트리 갱신 → setDatabase.
  }

  // 용어 적립: LLM이 뽑은 새 용어를 core.glossary에 중복 없이 추가.
  // newTerms 항목: { term, meaning }
  function updateGlossary(core, newTerms) {
    if (!Array.isArray(newTerms) || !newTerms.length) return;
    const MAX = 30;
    for (const t of newTerms) {
      if (!t || !t.term) continue;
      if (core.glossary.some((g) => g.term === t.term)) continue;
      core.glossary.push({ term: t.term, meaning: t.meaning || '', firstSeen: core.chapterCount + 1 });
    }
    if (core.glossary.length > MAX) core.glossary = core.glossary.slice(-MAX);
  }

  // A: 평판을 비율+관성으로. 우호/적대 "비율"로 ±, 매 회차 작게 움직이고 50으로 끌어당김.
  function updateReputation(core, comments, cfg) {
    if (!core.reputation) core.reputation = { hype: 50, anti: 0 };
    const arr = Array.isArray(comments) ? comments : [];
    if (!arr.length) return;

    let fav = 0, hostile = 0;
    for (const c of arr) {
      if (c.persona === '광팬') fav += 1;
      else if (c.persona === '차애러') fav += 0.5;
      else if (c.persona === '안티' || c.persona === '손절러') hostile += 1;
      else if (c.persona === '떡밥수집가') hostile += 0.2; // 추궁 성향 약하게
      else fav += 0.3; // 일반/익명은 약한 우호
    }
    const total = fav + hostile || 1;
    const favRatio = fav / total;            // 0~1
    const delta = (favRatio - 0.5) * 20;     // -10 ~ +10
    const meanPull = (50 - core.reputation.hype) * 0.15; // 관성: 50으로 약하게 회귀

    let next = core.reputation.hype + delta + meanPull;
    next = Math.max(0, Math.min(100, Math.round(next)));
    core.reputation.hype = next;
    core.reputation.anti = 100 - next; // 안티는 인기의 반대편 지표로 단순화
  }

  // ===========================================================================
  // 7. 플로팅 폰 셸 + 렌더 (세 미리보기 통합 / UI 디테일은 추후 조정)
  // ===========================================================================

  let activeTab = 'chapters';     // 'chapters' | 'community'
  let activeBoard = 'author'; // 커뮤니티 첫 진입 시 작가의 말 먼저

  // --- 공통 헬퍼 ---
  const esc = (s) => (s || '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const fmt = (n) => n >= 10000 ? (n / 10000).toFixed(1) + '만' : n >= 1000 ? (n / 1000).toFixed(1) + '천' : String(n);
  const ago = (ts) => { if (!ts) return '없음'; const m = Math.floor((Date.now() - ts) / 60000); return m < 1 ? '방금' : m < 60 ? m + '분 전' : Math.floor(m / 60) + '시간 전'; };

  async function openPhone() {
    await risuai.showContainer('fullscreen');
    const meta = document.createElement('meta');
    meta.name = 'viewport';
    meta.content = 'width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no';
    document.head.appendChild(meta);

    document.body.innerHTML = `
      <style>
        body { margin:0; background:transparent; width:100vw; height:100vh; overflow:hidden;
               font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; position:relative; }
        .backdrop { position:absolute; inset:0; z-index:1; cursor:pointer; }
        .phone { position:absolute; right:20px; bottom:80px; width:300px; height:75vh; max-height:640px;
                 background:#fff; border-radius:22px; box-shadow:0 12px 32px rgba(0,0,0,.28);
                 z-index:2; display:flex; flex-direction:column; overflow:hidden; }
        @media (max-width:600px){ .phone{ width:92vw; right:4vw; bottom:70px; height:80vh; } }
        .drag-bar { padding:11px 0 9px; background:#f4f4f6; border-bottom:1px solid #eee;
                    position:relative; cursor:grab; user-select:none; min-height:36px; box-sizing:border-box; }
        .drag-bar:active{ cursor:grabbing; }
        .grip { width:42px; height:4px; background:#cfcfd4; border-radius:999px; margin:0 auto; }
        .close { position:absolute; right:2px; top:50%; transform:translateY(-50%);
                 border:none; background:none; font-size:22px; cursor:pointer; color:#888;
                 width:44px; height:36px; display:flex; align-items:center; justify-content:center;
                 border-radius:8px; line-height:1; }
        .close:hover { background:#e0e0e6; color:#222; }
        .body { flex:1; overflow-y:auto; background:#fafafa; }
        .tabs { display:flex; border-top:1px solid #eee; }
        .tab { flex:1; text-align:center; padding:9px 0; font-size:11px; color:#999; cursor:pointer; }
        .tab.active { color:#222; font-weight:600; }

        /* 공통 색 변수 */
        .body { --line:#ececef; --text:#222; --sub:#666; --hint:#999;
                --point:#3f6fd6; --point-bg:#eef3fd; }

        /* 회차 댓글창 (.sc) */
        .sc-head { display:flex; align-items:center; gap:4px; padding:7px 9px; background:#fff; border-bottom:1px solid var(--line); }
        .sc-head .back { font-size:24px; color:var(--sub); cursor:pointer; padding:6px 12px;
                          border-radius:8px; user-select:none; line-height:1; min-width:44px;
                          min-height:36px; display:flex; align-items:center; justify-content:center; }
        .sc-head .back:hover { background:#e8e8ec; color:var(--text); }
        .sc-head .ttl { flex:1; padding-left:3px; }
        .sc-head .ttl b { display:block; font-size:14px; font-weight:600; color:var(--text); }
        .sc-head .ttl span { font-size:11px; color:var(--hint); }
        .sc-note { padding:10px 13px; background:#fdf4e0; border-bottom:1px solid var(--line); }
        .sc-note .lbl { font-size:11px; font-weight:600; color:#9a6a00; margin-bottom:3px; }
        .sc-note p { margin:0; font-size:12.5px; line-height:1.55; color:#9a6a00; }
        .sc-stat { display:flex; gap:13px; padding:9px 13px; background:#f3f3f5; font-size:11.5px; color:var(--sub); }
        .sc-cmt { padding:11px 13px; border-bottom:1px solid var(--line); }
        .sc-cmt.best { background:#eef3fd; }
        .sc-cmt .row { display:flex; align-items:center; gap:5px; margin-bottom:4px; flex-wrap:wrap; }
        .sc-cmt .name { font-size:12.5px; font-weight:600; color:var(--text); }
        .sc-cmt p { margin:0 0 6px; font-size:13px; line-height:1.55; color:var(--text); }
        .sc-cmt .meta { display:flex; gap:13px; font-size:11.5px; color:var(--sub); }
        .tag { font-size:10px; padding:1px 7px; border-radius:7px; line-height:1.6; }
        .tag.best { background:#fff; color:#3f6fd6; font-weight:600; }
        .tag.광팬 { background:#e7f6ed; color:#178a52; }
        .tag.떡밥수집가 { background:#fdf4e0; color:#9a6a00; }
        .tag.안티, .tag.손절러 { background:#fbecea; color:#c0392b; }
        .sc-input { display:flex; align-items:center; gap:8px; padding:10px 13px; background:#fff; border-top:1px solid var(--line); }
        .sc-input .box { flex:1; height:32px; border:1px solid #ddd; border-radius:8px; display:flex; align-items:center; padding:0 11px; font-size:12.5px; color:var(--hint); }

        /* 회차 목록 (.cl) */
        .cl-head { display:flex; align-items:center; padding:12px 13px; background:#fff; border-bottom:1px solid var(--line); }
        .cl-head b { flex:1; font-size:15px; font-weight:600; color:var(--text); }
        .cl-head .rep { font-size:11px; color:var(--sub); display:flex; gap:8px; align-items:center; }
        .cl-head .rep .bar { width:44px; height:5px; border-radius:3px; background:#eee; overflow:hidden; }
        .cl-head .rep .bar i { display:block; height:100%; background:#178a52; }
        .cl-close { margin:11px 13px; padding:12px; border:none; border-radius:10px; background:var(--point); color:#fff; font-size:13.5px; font-weight:600; width:calc(100% - 26px); cursor:pointer; }
        .cl-empty, .bd-empty { padding:30px 16px; text-align:center; color:var(--hint); font-size:12.5px; line-height:1.7; }
        .cl-item { display:flex; align-items:center; gap:11px; padding:12px 13px; border-bottom:1px solid var(--line); cursor:pointer; background:#fff; }
        .cl-item:active { background:#f5f5f7; }
        .cl-item .no { width:34px; height:34px; border-radius:9px; background:var(--point-bg); color:var(--point); font-size:11px; font-weight:600; display:flex; align-items:center; justify-content:center; flex-shrink:0; }
        .cl-item .info { flex:1; min-width:0; }
        .cl-item .info b { display:block; font-size:13.5px; font-weight:500; color:var(--text); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
        .cl-item .info span { font-size:11px; color:var(--hint); }
        .cl-item .cnt { font-size:13px; color:var(--hint); }

        /* 커뮤니티 게시판 (.bd) */
        .bd-head { display:flex; align-items:center; padding:12px 13px; background:#fff; border-bottom:1px solid var(--line); }
        .bd-head b { flex:1; font-size:15px; font-weight:600; color:var(--text); }
        .bd-head .refresh { font-size:12px; color:var(--point); cursor:pointer;
                            padding:6px 10px; margin:-6px -6px; border-radius:6px; user-select:none; }
        .bd-head .refresh:hover { background:var(--point-bg); }
        .bd-chips { display:flex; gap:6px; padding:10px 12px; background:#fff; border-bottom:1px solid var(--line); overflow-x:auto; }
        .bd-chips::-webkit-scrollbar { display:none; }
        .chip { flex-shrink:0; padding:6px 13px; border-radius:999px; border:1px solid #ddd; background:#fff; color:var(--sub); font-size:12px; cursor:pointer; white-space:nowrap; }
        .chip.active { background:var(--point-bg); border-color:var(--point); color:var(--point); font-weight:600; }
        .bd-meta { padding:7px 13px; font-size:10.5px; color:var(--hint); background:#f3f3f5; }
        .bd-post { padding:12px 13px; border-bottom:1px solid var(--line); background:#fff; }
        .bd-post .t { margin:0 0 4px; font-size:13.5px; font-weight:500; color:var(--text); line-height:1.45; }
        .bd-post .x { margin:0 0 8px; font-size:12.5px; color:var(--sub); line-height:1.55; }
        .bd-post .m { display:flex; gap:13px; font-size:11px; color:var(--hint); }
        .bd-post .m .who { font-weight:500; color:var(--sub); }
        .au-post { padding:12px 13px; background:#eef3fd; }
        .au-post .au-by { font-size:11px; font-weight:600; color:var(--point); margin-bottom:4px; }
        .au-post p { margin:0 0 6px; font-size:13px; line-height:1.55; color:var(--text); }
        .au-post .au-meta { font-size:11px; color:var(--hint); }

        /* 설정창 (.st) */
        .st-item { padding:12px 13px; border-bottom:1px solid var(--line); background:#fff; display:flex; flex-direction:column; gap:6px; }
        .st-item .row { display:flex; justify-content:space-between; align-items:center; gap:10px; }
        .st-item b { font-size:13px; font-weight:600; color:var(--text); }
        .st-item .desc { font-size:11px; color:var(--hint); line-height:1.4; }
        .st-item .val { font-size:13px; font-weight:600; color:var(--point); min-width:40px; text-align:right; }
        .st-item input[type="range"] { width:100%; accent-color:var(--point); margin:2px 0; }
        .st-item input[type="checkbox"] { width:18px; height:18px; accent-color:var(--point); flex-shrink:0; }
        .st-item select { font-size:12px; padding:5px 8px; border:1px solid #ddd; border-radius:6px; background:#fff; }
        .st-section { padding:8px 13px; background:#f3f3f5; font-size:11px; font-weight:600; color:var(--sub); }
      </style>
      <div class="backdrop" id="backdrop"></div>
      <div class="phone" id="phone">
        <div class="drag-bar" id="dragbar">
          <div class="grip"></div>
          <button class="close" id="close">&times;</button>
        </div>
        <div class="body" id="screen"></div>
        <div class="tabs">
          <div class="tab" id="tab-chapters">회차</div>
          <div class="tab" id="tab-community">커뮤니티</div>
          <div class="tab" id="tab-settings">설정</div>
        </div>
      </div>`;

    document.getElementById('backdrop').addEventListener('click', () => risuai.hideContainer());
    document.getElementById('close').addEventListener('click', () => risuai.hideContainer());
    document.getElementById('tab-chapters').addEventListener('click', () => { activeTab = 'chapters'; renderActiveTab(); });
    document.getElementById('tab-community').addEventListener('click', () => { activeTab = 'community'; renderActiveTab(); });
    document.getElementById('tab-settings').addEventListener('click', () => { activeTab = 'settings'; renderActiveTab(); });
    bindDrag();
    renderActiveTab();
  }

  function syncTabs() {
    const c = document.getElementById('tab-chapters');
    const m = document.getElementById('tab-community');
    const s = document.getElementById('tab-settings');
    if (c) c.classList.toggle('active', activeTab === 'chapters');
    if (m) m.classList.toggle('active', activeTab === 'community');
    if (s) s.classList.toggle('active', activeTab === 'settings');
  }

  function bindDrag() {
    // 플로팅메모의 드래그 로직 포팅: drag-bar 잡고 이동, right/bottom→left/top 전환.
    const phone = document.getElementById('phone');
    const bar = document.getElementById('dragbar');
    let on = false, sx, sy, l, t;
    const start = (e) => {
      if (e.target.closest('.close')) return;
      on = true;
      const p = e.touches ? e.touches[0] : e;
      sx = p.clientX; sy = p.clientY;
      const r = phone.getBoundingClientRect();
      phone.style.right = 'auto'; phone.style.bottom = 'auto';
      phone.style.left = r.left + 'px'; phone.style.top = r.top + 'px';
      l = r.left; t = r.top;
    };
    const move = (e) => {
      if (!on) return; e.preventDefault();
      const p = e.touches ? e.touches[0] : e;
      phone.style.left = (l + p.clientX - sx) + 'px';
      phone.style.top = (t + p.clientY - sy) + 'px';
    };
    const end = () => { on = false; };
    bar.addEventListener('mousedown', start);
    bar.addEventListener('touchstart', start, { passive: false });
    document.addEventListener('mousemove', move);
    document.addEventListener('touchmove', move, { passive: false });
    document.addEventListener('mouseup', end);
    document.addEventListener('touchend', end);
  }

  // 데스크톱 마우스로 칩 컨테이너 가로 드래그 스크롤. (모바일 터치는 overflow-x로 네이티브)
  function bindChipDrag(container) {
    if (!container) return;
    let down = false, sx, sl, draggedChip = null;
    container.addEventListener('mousedown', (e) => {
      down = true; sx = e.pageX; sl = container.scrollLeft;
      container.style.cursor = 'grabbing';
      draggedChip = e.target.closest('.chip');
      if (draggedChip) draggedChip._dragged = false;
    });
    const stop = () => { down = false; container.style.cursor = ''; };
    container.addEventListener('mouseleave', stop);
    container.addEventListener('mouseup', stop);
    container.addEventListener('mousemove', (e) => {
      if (!down) return;
      const dx = e.pageX - sx;
      if (Math.abs(dx) > 5 && draggedChip) draggedChip._dragged = true; // 5px 넘으면 드래그로 판정 → 클릭 무시
      container.scrollLeft = sl - dx * 1.2;
    });
  }

  function renderActiveTab() {
    syncTabs();
    if (activeTab === 'chapters') renderChapterList();
    else if (activeTab === 'community') renderBoard(activeBoard);
    else renderSettings();
  }

  // --- 회차 목록 ---
  async function renderChapterList() {
    const screen = document.getElementById('screen');
    const index = await load(await K.index(), []);
    const core = await loadCore();
    const rep = core.reputation || { hype: 50 };

    const items = index.length ? index.map((ch) => `
      <div class="cl-item" data-n="${ch.n}">
        <div class="no">${ch.n}화</div>
        <div class="info"><b>${esc(ch.title)}</b><span>댓글 ${ch.commentCount}</span></div>
        <div class="cnt">›</div>
      </div>`).join('')
      : `<div class="cl-empty">아직 연재한 회차가 없어요.<br>RP를 진행한 뒤 "이번 화 마감"을 눌러보세요.</div>`;

    screen.innerHTML = `
      <div class="cl-head">
        <b>내 연재</b>
        <div class="rep">인기 <div class="bar"><i style="width:${rep.hype}%"></i></div></div>
      </div>
      <button class="cl-close" id="cl-close">＋ 이번 화 마감</button>
      ${items}`;

    document.getElementById('cl-close').addEventListener('click', async () => {
      const btn = document.getElementById('cl-close');
      btn.disabled = true; btn.textContent = '독자 반응 생성 중…';
      try { await closeChapter(); } // 내부에서 renderComments까지
      catch (e) { console.error('[serial] 마감 실패', e); btn.disabled = false; btn.textContent = '＋ 이번 화 마감'; }
    });
    screen.querySelectorAll('.cl-item').forEach((el) => {
      el.addEventListener('click', () => renderComments(parseInt(el.dataset.n, 10)));
    });
  }

  // --- 회차 댓글창 ---
  async function renderComments(n) {
    activeTab = 'chapters'; syncTabs();
    const screen = document.getElementById('screen');
    const ch = await load(await K.ch(n), null);
    if (!ch) { screen.innerHTML = `<div class="cl-empty">회차를 찾을 수 없어요.</div>`; return; }

    const sorted = [...ch.comments].sort((a, b) => (b.best ? 1 : 0) - (a.best ? 1 : 0) || (b.likes || 0) - (a.likes || 0));
    const cmtHtml = sorted.map((c) => {
      const tags = [
        c.best ? `<span class="tag best">BEST</span>` : '',
        c.persona ? `<span class="tag ${c.persona}">${c.persona}</span>` : '',
      ].join('');
      const meta = [`△ ${fmt(c.likes || 0)}`, (c.replies != null ? `답글 ${c.replies}` : '')]
        .filter(Boolean).map((t) => `<span>${t}</span>`).join('');
      return `
        <div class="sc-cmt ${c.best ? 'best' : ''}">
          <div class="row"><span class="name">${esc(c.handle)}</span>${tags}</div>
          <p>${esc(c.text)}</p>
          <div class="meta">${meta}</div>
        </div>`;
    }).join('');

    screen.innerHTML = `
      <div class="sc-head">
        <span class="back" id="sc-back">‹</span>
        <div class="ttl"><b>${ch.n}화 댓글</b><span>${esc(ch.title)}</span></div>
        <span style="color:var(--sub);">🔔</span>
      </div>
      <div class="sc-stat">
        <span>👁 ${fmt(ch.views || 0)}</span>
        <span>💬 ${ch.comments.length}</span>
        <span>★ ${ch.rating || '-'}</span>
        <span style="margin-left:auto;color:var(--hint);">베스트순 ▾</span>
      </div>
      ${cmtHtml}
      <div class="sc-input"><div class="box">댓글 달기…</div><span style="font-size:18px;color:var(--sub);">➤</span></div>`;

    document.getElementById('sc-back').addEventListener('click', () => renderChapterList());
  }

  // --- 커뮤니티 게시판 (작가의 말 + 일반 3종) ---
  async function renderBoard(type) {
    activeBoard = type;
    const screen = document.getElementById('screen');

    const chips = ALL_CHIPS.map((t) =>
      `<div class="chip ${t === type ? 'active' : ''}" data-type="${t}">${CHIP_LABEL[t]}</div>`).join('');

    if (type === 'author') {
      // 양방향: 작가 글 + 독자 댓글
      const store = await load(await K.author(), { posts: [] });
      const postsHtml = store.posts.length ? store.posts.map((p) => {
        const cm = (p.comments || []).map((c) => {
          const tags = [
            c.best ? `<span class="tag best">BEST</span>` : '',
            c.persona ? `<span class="tag ${c.persona}">${c.persona}</span>` : '',
          ].join('');
          return `<div class="sc-cmt ${c.best ? 'best' : ''}" style="padding:9px 13px;">
              <div class="row"><span class="name">${esc(c.handle)}</span>${tags}</div>
              <p style="margin:0;font-size:12.5px;">${esc(c.text)}</p></div>`;
        }).join('');
        return `<div style="border-bottom:6px solid #f0f0f3;">
            <div class="au-post">
              <div class="au-by">✎ 작가</div>
              <p>${esc(p.text)}</p>
              <div class="au-meta">△ ${p.likes || 0} · 댓글 ${(p.comments || []).length}</div>
            </div>${cm}</div>`;
      }).join('') : `<div class="bd-empty">아직 작가 글이 없어요.<br>"글쓰기"로 독자에게 말을 걸어보세요.</div>`;

      screen.innerHTML = `
        <div class="bd-head"><b>커뮤니티</b><span class="refresh" id="au-write">✎ 글쓰기</span></div>
        <div class="bd-chips">${chips}</div>
        ${postsHtml}`;

      screen.querySelectorAll('.chip').forEach((el) =>
        el.addEventListener('click', (e) => {
          if (el._dragged) { el._dragged = false; return; }
          renderBoard(el.dataset.type);
        }));
      bindChipDrag(screen.querySelector('.bd-chips'));
      document.getElementById('au-write').addEventListener('click', async () => {
        const body = prompt('독자에게 남길 작가의 글 (공지·소회·예고 등):', '');
        if (!body || !body.trim()) return;
        const btn = document.getElementById('au-write');
        btn.textContent = '독자 반응 생성 중…';
        try { await postAuthorMessage(body); }
        catch (e) { console.error('[serial] 작가 글 실패', e); renderBoard('author'); }
      });
      return;
    }

    // 일반 게시판(LLM이 글 생성)
    const board = await load(await K.board(type), { posts: [], lastRefreshAt: null });
    const posts = board.posts.length ? board.posts.map((p) => `
      <div class="bd-post">
        <p class="t">${esc(p.title)}</p>
        <p class="x">${esc(p.text)}</p>
        <div class="m"><span class="who">${esc(p.handle)}</span><span>△ ${p.likes || 0}</span><span>댓글 ${p.replies || 0}</span></div>
      </div>`).join('')
      : `<div class="bd-empty">아직 글이 없어요.<br>"새로고침"을 누르면 독자들이 글을 씁니다.</div>`;

    screen.innerHTML = `
      <div class="bd-head"><b>커뮤니티</b><span class="refresh" id="bd-refresh">↻ 새로고침</span></div>
      <div class="bd-chips">${chips}</div>
      <div class="bd-meta">마지막 갱신: ${ago(board.lastRefreshAt)}</div>
      ${posts}`;

    screen.querySelectorAll('.chip').forEach((el) =>
      el.addEventListener('click', (e) => {
        if (el._dragged) { el._dragged = false; return; }
        renderBoard(el.dataset.type);
      }));
    bindChipDrag(screen.querySelector('.bd-chips'));
    document.getElementById('bd-refresh').addEventListener('click', async () => {
      const btn = document.getElementById('bd-refresh');
      btn.textContent = '생성 중…';
      try {
        const cfg = await settings();
        const posts = await genBoardPosts(type, cfg);
        await save(await K.board(type), { posts, lastRefreshAt: Date.now() });
      } catch (e) { console.error('[serial] 게시판 생성 실패', e); }
      renderBoard(type);
    });
  }

  // --- 설정창 (12개 전부 인앱 편집) ---
  async function renderSettings() {
    const screen = document.getElementById('screen');
    const cfg = await settings();

    // 토글 행 (체크박스)
    const tg = (key, label, desc, on) => `
      <div class="st-item">
        <div class="row">
          <div style="flex:1;"><b>${label}</b><div class="desc">${desc}</div></div>
          <input type="checkbox" data-st="${key}" data-kind="bool" ${on ? 'checked' : ''}>
        </div>
      </div>`;
    // 슬라이더 행
    const sl = (key, label, desc, val, min, max) => `
      <div class="st-item">
        <div class="row"><b>${label}</b><span class="val" id="v-${key}">${val}</span></div>
        <div class="desc">${desc}</div>
        <input type="range" data-st="${key}" data-kind="num" min="${min}" max="${max}" value="${val}">
      </div>`;
    // 드롭다운 행
    const sel = (key, label, desc, val, opts) => `
      <div class="st-item">
        <div class="row">
          <div style="flex:1;"><b>${label}</b><div class="desc">${desc}</div></div>
          <select data-st="${key}" data-kind="str">
            ${opts.map(o => `<option value="${o[0]}" ${val === o[0] ? 'selected' : ''}>${o[1]}</option>`).join('')}
          </select>
        </div>
      </div>`;

    screen.innerHTML = `
      <div class="cl-head"><b>설정</b></div>

      <div class="st-section">생성 분량 (자주 만짐)</div>
      ${sl('comment_count', '회차당 댓글 수', '마감 시 생성될 댓글 개수 (대략)', cfg.commentCount, 3, 20)}
      ${sl('board_post_count', '게시판 글 수', '게시판 새로고침 시 글 개수', cfg.boardPostCount, 3, 15)}

      <div class="st-section">분위기 / 톤</div>
      ${sl('mood_bias', '분위기 보정', '평판 위에 ±. 음수=싸늘, 양수=우호', cfg.moodBias, -50, 50)}
      ${sl('flame_cap', '악플 수위', '높을수록 거친 비난·독설 허용 (1~5)', cfg.flameCap, 1, 5)}
      ${tg('allow_nsfw', 'NSFW 허용', '성인 작품 전개에 대한 직접적 반응', cfg.allowNsfw)}

      <div class="st-section">기억 시스템</div>
      ${tg('use_regulars', '단골 기억', '인상적인 독자를 기억해 다음 회차에도 재등장', cfg.useRegulars)}
      ${tg('use_glossary', '용어 적립', '커플링명·밈을 적립해 일관되게 재사용', cfg.useGlossary)}

      <div class="st-section">생성 방식</div>
      ${sel('foreshadow_mode', '떡밥 추출 방식', '기본 권장. 떡밥 추출이 부정확할 때만 분리로.', cfg.foreshadowMode,
        [['combined', '통합 (1회·기본)'], ['split', '분리 (2회·정확)']])}
      ${sel('body_mode', '회차 본문 저장', '요약(가벼움) / 전체(정확)', cfg.bodyMode,
        [['summary', '요약'], ['full', '전체']])}
      ${sel('comment_model', '댓글 모델', '보조(저렴) / 일반(고품질)', cfg.commentModel,
        [['submodel', '보조모델'], ['model', '일반모델']])}

      <div class="st-section">기타</div>
      ${tg('auto_close', '자동 마감', 'RP 출력마다 자동으로 회차 마감 (호출 잦음)', cfg.autoClose)}
      ${tg('use_hypa', '하이파 배경맥락', '하이파 켜져 있으면 배경 요약을 댓글에 얹기', cfg.useHypa)}
    `;

    // 공통 저장 핸들러
    const setOverride = async (key, raw) => {
      const overrides = await load(K.settings, {});
      overrides[key] = raw;
      await save(K.settings, overrides);
    };

    // 체크박스/드롭다운: change, 슬라이더: input(드래그 중 실시간 표시 + 저장)
    screen.querySelectorAll('[data-st]').forEach((el) => {
      const key = el.dataset.st;
      const kind = el.dataset.kind;
      const ev = (el.type === 'range') ? 'input' : 'change';
      el.addEventListener(ev, () => {
        let v;
        if (kind === 'bool') v = el.checked ? '1' : '0';
        else if (kind === 'num') {
          v = String(el.value);
          const vEl = document.getElementById(`v-${key}`);
          if (vEl) vEl.textContent = v;
        } else v = el.value;
        setOverride(key, v);
      });
    });
  }

  // ===========================================================================
  // 8. 진입점
  // ===========================================================================

  async function initPlugin() {
    // 채팅창 옆 버튼으로 폰 열기 (말풍선 아이콘 적용)
    await risuai.registerButton(
      { name: '연재처 열기', icon: '💬', iconType: 'html', location: 'chat', id: 'btn-serial-open' },
      openPhone
    );

    // 자동 마감 옵션: RP 출력이 나올 때마다 감지
    risuai.addRisuReplacer('afterRequest', async (content, type) => {
      try {
        const cfg = await settings();
        if (cfg.autoClose) await closeChapter();
      } catch (e) { console.error('[serial] 자동 마감 실패', e); }
      return content; // 본문은 건드리지 않음 (읽기만)
    });
  }

  await initPlugin();
})();
