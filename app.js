const $ = (id) => document.getElementById(id);
const DIFFICULTY_LABELS = { intro: "初級", basic: "基礎", standard: "標準", advanced: "発展" };
const STORAGE_KEY = "info1TrainingStatsV1";
const LAST_CONFIG_KEY = "info1TrainingLastConfigV1";
const QUIZ_PROGRESS_KEY = "info1TrainingQuizProgressV1";
const TUTORIAL_HIDDEN_KEY = "info1TrainingTutorialHiddenV1";
const MEDAL_RECENT_LIMIT = 10;
const ANALYSIS_RECENT_LIMIT = 30;
const WRONG_LIST_LIMIT = 100;
const LEARNING_LOG_ENDPOINT = "https://script.google.com/macros/s/AKfycbwt9wfbEaB0WEi-Bb7XsHxyo9N283sWhOljODYmOxJKmm23ff7vu4hzxTeNNwVjkoom3w/exec";
const STUDENT_PROFILE_KEY = "info1TrainingStudentProfileV1";
const PENDING_LOGS_KEY = "info1TrainingPendingLearningLogsV1";
const MAX_PENDING_LOGS = 50;
const UPDATE_HISTORY_URL = "update-history.json";
const UPDATE_HISTORY_LIMIT = 10;
const HISTORY_PAGE_SIZE = 10;

const CATEGORY_ORDER = [
  "情報社会と法",
  "情報デザイン",
  "コンピュータの仕組み",
  "プログラミング",
  "ネットワークとセキュリティ",
  "データ活用"
];

function getOrderedCategories(categoryCounts){
  return Object.keys(categoryCounts).sort((a, b) => {
    const ai = CATEGORY_ORDER.indexOf(a);
    const bi = CATEGORY_ORDER.indexOf(b);
    if (ai === -1 && bi === -1) return a.localeCompare(b, 'ja');
    if (ai === -1) return 1;
    if (bi === -1) return -1;
    return ai - bi;
  });
}


let sessionQuestions = [];
let currentIndex = 0;
let sessionAnswers = [];
let lastConfig = { category: "all", difficulty: "all", count: 10 };
let statusActiveTab = "priority";
let statusVisibleCount = 10;
let selectedQuestionIds = new Set();
let historyCurrentPage = 1;
let historyPageRows = [];
let sessionStartedAt = null;
let lastSyncMessage = "";
let isFlushingLearningLogs = false;

function loadStudentProfile(){
  try{
    const profile = JSON.parse(localStorage.getItem(STUDENT_PROFILE_KEY) || 'null');
    if(!profile || !profile.grade || !profile.classNumber || !profile.studentNumber) return null;
    return profile;
  }catch(e){ return null; }
}

function normalizeNumber(value, min, max){
  const num = Number(String(value || '').trim());
  if(!Number.isInteger(num) || num < min || num > max) return null;
  return num;
}

function buildStudentId(profile){
  if(!profile) return "";
  return `${profile.grade}${profile.classNumber}${String(profile.studentNumber).padStart(2, '0')}`;
}

function saveStudentProfileFromForm(){
  const grade = normalizeNumber($('studentGradeSelect')?.value, 1, 3);
  const classNumber = normalizeNumber($('studentClassInput')?.value, 1, 9);
  const studentNumber = normalizeNumber($('studentNumberInput')?.value, 1, 99);
  if(!grade || !classNumber || !studentNumber){
    setStudentProfileMessage('学年・組・番号を正しく入力してください。', 'warn');
    return;
  }

  const currentProfile = loadStudentProfile();
  const nextProfile = { grade, classNumber, studentNumber, studentId: buildStudentId({ grade, classNumber, studentNumber }), savedAt: new Date().toISOString() };
  const isChanged = currentProfile && buildStudentId(currentProfile) !== nextProfile.studentId;
  if(isChanged){
    const ok = window.confirm(`登録情報を ${currentProfile.grade}年${currentProfile.classNumber}組${currentProfile.studentNumber}番 から ${grade}年${classNumber}組${studentNumber}番 に変更します。

すでに送信済みの記録はスプレッドシート側では自動修正されません。今後の記録と未送信データは新しいIDで送信します。変更してよいですか？`);
    if(!ok) return;
  }

  localStorage.setItem(STUDENT_PROFILE_KEY, JSON.stringify(nextProfile));
  setStudentProfileMessage(`登録しました：${grade}年${classNumber}組${studentNumber}番（ID：${nextProfile.studentId}）`, 'ok');
  renderStudentProfileBox();
  flushPendingLearningLogs();
}

function resetStudentProfileForCorrection(){
  const currentProfile = loadStudentProfile();
  if(currentProfile){
    const ok = window.confirm(`現在の登録（${currentProfile.grade}年${currentProfile.classNumber}組${currentProfile.studentNumber}番）をこの端末から消して、入力し直せる状態にします。

すでに送信済みの記録はスプレッドシート側では自動削除されません。続けますか？`);
    if(!ok) return;
  }
  localStorage.removeItem(STUDENT_PROFILE_KEY);
  if($('studentGradeSelect')) $('studentGradeSelect').value = '1';
  if($('studentClassInput')) $('studentClassInput').value = '';
  if($('studentNumberInput')) $('studentNumberInput').value = '';
  lastSyncMessage = '登録情報を消しました。正しい学年・組・番号を入力して、もう一度登録してください。';
  renderStudentProfileBox();
}

function setStudentProfileMessage(message, type = ''){
  const el = $('studentProfileMessage');
  if(!el) return;
  el.textContent = message;
  el.className = `student-profile-message ${type}`.trim();
}

function loadPendingLearningLogs(){
  try{
    const logs = JSON.parse(localStorage.getItem(PENDING_LOGS_KEY) || '[]');
    return Array.isArray(logs) ? logs : [];
  }catch(e){ return []; }
}

function savePendingLearningLogs(logs){
  localStorage.setItem(PENDING_LOGS_KEY, JSON.stringify(logs.slice(-MAX_PENDING_LOGS)));
}

function getPendingLogCount(){
  return loadPendingLearningLogs().length;
}

function makeClientSessionId(){
  return `session_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

function enqueueLearningLog(payload){
  const logs = loadPendingLearningLogs();
  const nextPayload = { ...payload };
  if(!nextPayload.sessionId){
    nextPayload.sessionId = makeClientSessionId();
  }
  logs.push({
    id: nextPayload.sessionId,
    payload: nextPayload,
    createdAt: new Date().toISOString()
  });
  savePendingLearningLogs(logs);
  renderStudentProfileBox();
}

async function sendLearningLog(payload){
  await fetch(LEARNING_LOG_ENDPOINT, {
    method: 'POST',
    mode: 'no-cors',
    headers: { 'Content-Type': 'text/plain' },
    body: JSON.stringify(payload)
  });
}

async function flushPendingLearningLogs(){
  const profile = loadStudentProfile();
  if(!profile){
    renderStudentProfileBox();
    return;
  }

  if(isFlushingLearningLogs){
    lastSyncMessage = '送信処理中です。完了するまでお待ちください。';
    renderStudentProfileBox();
    return;
  }

  let logs = loadPendingLearningLogs();
  if(!logs.length){
    lastSyncMessage = '未送信データはありません。';
    renderStudentProfileBox();
    return;
  }

  isFlushingLearningLogs = true;
  const resendBtn = $('resendLogsBtn');
  if(resendBtn) resendBtn.disabled = true;

  const remaining = [];
  try{
    for(const item of logs){
      try{
        const stableSessionId = item.payload?.sessionId || item.id || makeClientSessionId();
        const payload = {
          ...item.payload,
          sessionId: stableSessionId,
          studentId: buildStudentId(profile),
          grade: profile.grade,
          classNumber: profile.classNumber,
          studentNumber: profile.studentNumber
        };
        await sendLearningLog(payload);
      }catch(e){
        remaining.push(item);
      }
    }

    savePendingLearningLogs(remaining);
    lastSyncMessage = remaining.length
      ? `未送信データが${remaining.length}件残っています。通信できる状態で再送してください。`
      : '学習記録を送信しました。';
  }finally{
    isFlushingLearningLogs = false;
    renderStudentProfileBox();
  }
}

function renderStudentProfileBox(){
  if(!$('studentGradeSelect')) return;
  const profile = loadStudentProfile();
  const pending = getPendingLogCount();
  if(profile){
    $('studentGradeSelect').value = String(profile.grade);
    $('studentClassInput').value = String(profile.classNumber);
    $('studentNumberInput').value = String(profile.studentNumber);
  }
  const resendBtn = $('resendLogsBtn');
  if(resendBtn){
    const canResend = Boolean(profile) && pending > 0 && !isFlushingLearningLogs;
    resendBtn.disabled = !canResend;
    resendBtn.setAttribute('aria-disabled', String(!canResend));
    resendBtn.title = !profile
      ? '学年・組・番号を登録すると利用できます。'
      : pending > 0
        ? '未送信データを再送します。'
        : '未送信データはありません。';
  }

  const badge = $('syncStatusBadge');
  if(badge){
    if(!profile){
      badge.textContent = '未登録';
      badge.className = 'sync-status-badge warn';
    }else if(pending){
      badge.textContent = `未送信 ${pending}件`;
      badge.className = 'sync-status-badge pending';
    }else{
      badge.textContent = `ID ${profile.studentId}`;
      badge.className = 'sync-status-badge ok';
    }
  }
  const message = profile
    ? `${profile.grade}年${profile.classNumber}組${profile.studentNumber}番として記録します。${pending ? ` 未送信データ：${pending}件。` : ''}${lastSyncMessage ? ` ${lastSyncMessage}` : ''}`
    : '学習記録を送信するには、最初に学年・組・番号を登録してください。';
  setStudentProfileMessage(message, profile ? (pending ? 'warn' : 'ok') : 'warn');
}

function buildCategorySummary(answers){
  return answers.reduce((summary, a) => {
    summary[a.category] ||= { total:0, correct:0 };
    summary[a.category].total++;
    if(a.correct) summary[a.category].correct++;
    return summary;
  }, {});
}

function getAnsweredSessionAnswers(){
  return sessionAnswers.filter(a => a && a.id);
}

function buildLearningSessionPayload(){
  const profile = loadStudentProfile();
  const now = new Date();
  const startedAt = sessionStartedAt || now.toISOString();
  const finishedAt = now.toISOString();
  const answered = getAnsweredSessionAnswers();
  const totalQuestions = answered.length;
  const correctCount = answered.filter(a => a.correct).length;
  const studySeconds = Math.max(0, Math.round((new Date(finishedAt).getTime() - new Date(startedAt).getTime()) / 1000));
  const details = answered.map(a => {
    const q = sessionQuestions.find(item => item.id === a.id) || QUESTIONS.find(item => item.id === a.id) || {};
    return {
      questionId: a.id,
      category: a.category,
      selectedIndex: a.selected,
      selectedAnswer: q.choices?.[a.selected] || '',
      correctAnswer: q.choices?.[q.answer] || '',
      isCorrect: a.correct,
      confidence: a.confidence || ''
    };
  });
  return {
    submittedAt: finishedAt,
    startedAt,
    finishedAt,
    studentId: profile ? buildStudentId(profile) : '',
    grade: profile?.grade || '',
    classNumber: profile?.classNumber || '',
    studentNumber: profile?.studentNumber || '',
    mode: lastConfig?.selectedIds ? 'selected' : 'normal',
    category: lastConfig?.category || 'all',
    difficulty: lastConfig?.difficulty || 'all',
    totalQuestions,
    correctCount,
    accuracy: totalQuestions ? Math.round(correctCount / totalQuestions * 100) : 0,
    studySeconds,
    categorySummary: buildCategorySummary(answered),
    answers: details,
    userAgent: navigator.userAgent,
    appName: 'OH-TECH'
  };
}

function buildSingleAnswerPayload(answer, answerIndex){
  const profile = loadStudentProfile();
  const now = new Date();
  const startedAt = sessionStartedAt || now.toISOString();
  const finishedAt = now.toISOString();
  const q = sessionQuestions.find(item => item.id === answer.id) || QUESTIONS.find(item => item.id === answer.id) || {};
  const detail = {
    questionId: answer.id,
    category: answer.category,
    selectedIndex: answer.selected,
    selectedAnswer: q.choices?.[answer.selected] || '',
    correctAnswer: q.choices?.[q.answer] || '',
    isCorrect: answer.correct,
    confidence: answer.confidence || ''
  };
  const correctCount = answer.correct ? 1 : 0;
  return {
    sessionId: answer.syncId || makeClientSessionId(),
    submittedAt: finishedAt,
    startedAt,
    finishedAt,
    studentId: profile ? buildStudentId(profile) : '',
    grade: profile?.grade || '',
    classNumber: profile?.classNumber || '',
    studentNumber: profile?.studentNumber || '',
    mode: lastConfig?.selectedIds ? 'selected' : 'normal',
    category: answer.category || lastConfig?.category || 'all',
    difficulty: q.difficulty || lastConfig?.difficulty || 'all',
    totalQuestions: 1,
    correctCount,
    accuracy: answer.correct ? 100 : 0,
    studySeconds: Math.max(0, Math.round((new Date(finishedAt).getTime() - new Date(startedAt).getTime()) / 1000)),
    categorySummary: buildCategorySummary([answer]),
    answers: [detail],
    userAgent: navigator.userAgent,
    appName: 'OH-TECH',
    eventType: 'answer',
    questionNumber: answerIndex + 1,
    plannedQuestionCount: sessionQuestions.length
  };
}

function recordAnsweredQuestionForSync(answerIndex){
  const answer = sessionAnswers[answerIndex];
  if(!answer || !answer.id) return false;
  if(answer.syncQueued) return false;
  answer.syncId = answer.syncId || makeClientSessionId();
  answer.syncQueued = true;
  const payload = buildSingleAnswerPayload(answer, answerIndex);
  enqueueLearningLog(payload);
  saveQuizProgress();

  if(!loadStudentProfile()){
    lastSyncMessage = '生徒IDが未登録のため、解答結果はこの端末内に一時保存しました。登録後に送信されます。';
    renderStudentProfileBox();
    return true;
  }
  flushPendingLearningLogs();
  return true;
}

function recordLearningSessionForSync(){
  const payload = buildLearningSessionPayload();
  if(!payload.answers || payload.answers.length === 0){
    lastSyncMessage = '解答がないため、学習記録は送信しませんでした。';
    renderStudentProfileBox();
    return false;
  }

  enqueueLearningLog(payload);
  if(!loadStudentProfile()){
    lastSyncMessage = '生徒IDが未登録のため、結果はこの端末内に一時保存しました。登録後に送信されます。';
    renderStudentProfileBox();
    return true;
  }
  flushPendingLearningLogs();
  return true;
}

function loadStats(){
  const defaults = { sessions:0, answered:0, correct:0, byCategory:{}, wrongIds:[], questionStats:{}, daily:{} };
  const stats = JSON.parse(localStorage.getItem(STORAGE_KEY) || JSON.stringify(defaults));
  stats.sessions ||= 0;
  stats.answered ||= 0;
  stats.correct ||= 0;
  stats.byCategory ||= {};
  stats.wrongIds ||= [];
  stats.questionStats ||= {};
  stats.daily ||= {};
  return stats;
}
function saveStats(stats){ localStorage.setItem(STORAGE_KEY, JSON.stringify(stats)); }
function showPanel(id){ document.querySelectorAll('.panel').forEach(p=>p.classList.remove('active')); $(id).classList.add('active'); }
function shuffle(array){
  const copied = [...array];
  for(let i = copied.length - 1; i > 0; i--){
    const j = Math.floor(Math.random() * (i + 1));
    [copied[i], copied[j]] = [copied[j], copied[i]];
  }
  return copied;
}

function randomizeChoices(question){
  const choices = question.choices.map((choice, index) => ({ choice, originalIndex: index }));
  const shuffledChoices = shuffle(choices);
  return {
    ...question,
    choices: shuffledChoices.map(item => item.choice),
    answer: shuffledChoices.findIndex(item => item.originalIndex === question.answer),
    originalAnswer: question.answer
  };
}


function saveQuizProgress(){
  const data = {sessionQuestions,currentIndex,sessionAnswers,lastConfig};
  localStorage.setItem(QUIZ_PROGRESS_KEY, JSON.stringify(data));
}
function clearQuizProgress(){
  localStorage.removeItem(QUIZ_PROGRESS_KEY);
}
function loadQuizProgress(){
  try{
    return JSON.parse(localStorage.getItem(QUIZ_PROGRESS_KEY) || 'null');
  }catch(e){ return null; }
}

function getCategoryCounts(){
  return QUESTIONS.reduce((counts, q) => {
    counts[q.category] = (counts[q.category] || 0) + 1;
    return counts;
  }, {});
}

function getDifficultyCounts(questions = QUESTIONS){
  return questions.reduce((counts, q) => {
    counts[q.difficulty] = (counts[q.difficulty] || 0) + 1;
    return counts;
  }, {});
}

function getCategoryDifficultyCounts(){
  return QUESTIONS.reduce((counts, q) => {
    counts[q.category] ||= {};
    counts[q.category][q.difficulty] = (counts[q.category][q.difficulty] || 0) + 1;
    return counts;
  }, {});
}

function getQuestionResultLabel(record){
  if(!record || !record.attempts) return '<span class="status-badge untried">未実施</span>';
  return record.lastCorrect
    ? '<span class="status-badge correct">正答</span>'
    : '<span class="status-badge wrong">誤答</span>';
}

function getQuestionAccuracy(record){
  if(!record || !record.attempts) return '--%';
  return Math.round(record.correct / record.attempts * 100) + '%';
}

function formatDateTime(value){
  if(!value) return '';
  const date = new Date(value);
  if(Number.isNaN(date.getTime())) return '';
  return date.toLocaleString('ja-JP', { month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit' });
}


function getRecordConfidenceCounts(record){
  return record?.confidenceCounts || {};
}

function getDominantSelfCheck(record){
  const counts = getRecordConfidenceCounts(record);
  const confident = counts.confident || 0;
  const guess = counts.guess || 0;
  const incorrect = counts.incorrect || 0;
  const last = record?.lastConfidence;
  if(!record || !record.attempts) return '未実施';
  if(confident === 0 && guess === 0 && incorrect === 0){
    return last ? ({confident:'自信あり', guess:'勘', incorrect:'不正解'}[last] || '-') : '-';
  }
  const entries = [
    ['自信あり', confident],
    ['勘', guess],
    ['不正解', incorrect]
  ].sort((a,b)=>b[1]-a[1]);
  return entries[0][1] ? `${entries[0][0]} ${entries[0][1]}回` : '-';
}

function getRecentAnswerStats(record, limit = 10){
  const raw = Array.isArray(record?.recentAnswers) ? record.recentAnswers : [];
  const recent = raw.slice(-limit);
  const attempts = recent.length;
  const correct = recent.filter(item => item?.correct === true).length;
  return { attempts, correct, accuracy: attempts ? correct / attempts : null, source:'recent' };
}

function getWeakAnswerStats(record, limit = MEDAL_RECENT_LIMIT){
  const recent = getRecentAnswerStats(record, limit);
  if(recent.attempts > 0) return recent;
  const attempts = record?.attempts || 0;
  const correct = record?.correct || 0;
  return {
    attempts,
    correct,
    accuracy: attempts ? correct / attempts : null,
    source:'cumulative'
  };
}

function getWeakLabel(row){
  const pct = row.weakAccuracy === null ? '--%' : `${Math.round(row.weakAccuracy * 100)}%`;
  const prefix = row.weakSource === 'recent' ? `直近${row.weakAttempts}回` : '累積';
  return `${prefix} ${pct}`;
}

function getHistoryRows(){
  const stats = loadStats();
  return QUESTIONS.map(q => {
    const record = stats.questionStats[q.id];
    const attempts = record?.attempts || 0;
    const correct = record?.correct || 0;
    const accuracy = attempts ? correct / attempts : null;
    const medalRecent = getRecentAnswerStats(record, MEDAL_RECENT_LIMIT);
    const analysisRecent = getRecentAnswerStats(record, ANALYSIS_RECENT_LIMIT);
    const confidenceCounts = getRecordConfidenceCounts(record);
    return {
      q,
      record,
      attempts,
      correct,
      accuracy,
      recentAttempts: medalRecent.attempts,
      recentCorrect: medalRecent.correct,
      recentAccuracy: medalRecent.accuracy,
      analysisRecentAttempts: analysisRecent.attempts,
      analysisRecentCorrect: analysisRecent.correct,
      analysisRecentAccuracy: analysisRecent.accuracy,
      confidenceCounts
    };
  });
}

function getAccuracyStatus(row){
  if(row.attempts === 0) return { key:'untried', label:'未実施', medal:'', className:'untried' };
  if(row.recentAttempts < MEDAL_RECENT_LIMIT) return { key:'waiting', label:`直近${row.recentAttempts}回・${MEDAL_RECENT_LIMIT}回未満`, medal:'', className:'waiting' };
  const pct = (row.recentAccuracy ?? 0) * 100;
  if(pct >= 90) return { key:'gold', label:`直近${MEDAL_RECENT_LIMIT}回 90％以上`, medal:'🥇', className:'gold' };
  if(pct >= 70) return { key:'silver', label:`直近${MEDAL_RECENT_LIMIT}回 70％以上`, medal:'🥈', className:'silver' };
  if(pct >= 50) return { key:'bronze', label:`直近${MEDAL_RECENT_LIMIT}回 50％以上`, medal:'🥉', className:'bronze' };
  return { key:'under50', label:`直近${MEDAL_RECENT_LIMIT}回 50％未満`, medal:'', className:'under50' };
}

function getStatusRows(){
  return getHistoryRows().map(row => ({ ...row, status: getAccuracyStatus(row) }));
}

function escapeHtml(value){
  return String(value ?? '').replace(/[&<>"']/g, ch => ({
    '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'
  }[ch]));
}


function isCalculationQuestion(q){
  return String(q?.id || '').startsWith('calc_') || q?.isCalculation === true;
}

function passesCalculationMode(q, mode){
  if(mode === 'only') return isCalculationQuestion(q);
  if(mode === 'exclude') return !isCalculationQuestion(q);
  return true;
}

function renderStatusSummary(rows){
  const done = rows.filter(r => r.attempts > 0).length;
  const untried = rows.filter(r => r.attempts === 0).length;
  const gold = rows.filter(r => r.status.key === 'gold').length;
  const silver = rows.filter(r => r.status.key === 'silver').length;
  const bronze = rows.filter(r => r.status.key === 'bronze').length;
  const under50 = rows.filter(r => r.status.key === 'under50').length;
  const waiting = rows.filter(r => r.status.key === 'waiting').length;
  const priority = rows.filter(r => r.status.key === 'under50' || r.status.key === 'bronze').length;
  $('statusSummary').innerHTML = `
    <button class="status-summary-card priority" data-status-tab-jump="priority"><strong>重点復習</strong><span>${priority}問</span></button>
    <button class="status-summary-card untried" data-status-tab-jump="untried"><strong>未実施</strong><span>${untried}問</span></button>
    <button class="status-summary-card done" data-status-filter="done"><strong>学習済み</strong><span>${done}問</span></button>
    <button class="status-summary-card gold" data-status-filter="gold"><strong>🥇 直近10回 90％以上</strong><span>${gold}問</span></button>
    <button class="status-summary-card silver" data-status-filter="silver"><strong>🥈 直近10回 70％以上</strong><span>${silver}問</span></button>
    <button class="status-summary-card bronze" data-status-filter="bronze"><strong>🥉 直近10回 50％以上</strong><span>${bronze}問</span></button>
    <button class="status-summary-card under50" data-status-filter="under50"><strong>直近10回 50％未満</strong><span>${under50}問</span></button>
    <button class="status-summary-card done" data-status-filter="waiting"><strong>10回未満</strong><span>${waiting}問</span></button>
  `;
  document.querySelectorAll('[data-status-filter]').forEach(btn => {
    btn.addEventListener('click', () => {
      statusActiveTab = 'all';
      statusVisibleCount = 10;
      $('statusTypeFilter').value = btn.dataset.statusFilter;
      updateStatusTabs();
      renderStatusBoard();
    });
  });
  document.querySelectorAll('[data-status-tab-jump]').forEach(btn => {
    btn.addEventListener('click', () => {
      statusActiveTab = btn.dataset.statusTabJump;
      statusVisibleCount = 10;
      $('statusTypeFilter').value = 'all';
      updateStatusTabs();
      renderStatusBoard();
    });
  });
}

function updateStatusTabs(){
  document.querySelectorAll('[data-status-tab]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.statusTab === statusActiveTab);
  });
}

function passesStatusTab(row){
  if(statusActiveTab === 'priority') return row.status.key === 'under50' || row.status.key === 'bronze';
  if(statusActiveTab === 'untried') return row.status.key === 'untried';
  if(statusActiveTab === 'medals') return ['gold', 'silver', 'bronze'].includes(row.status.key);
  return true;
}

function passesStatusFilter(row, filter){
  if(filter === 'all') return true;
  if(filter === 'done') return row.attempts > 0;
  return row.status.key === filter;
}

function sortStatusRows(rows, sortKey){
  const categoryRank = (cat) => {
    const i = CATEGORY_ORDER.indexOf(cat);
    return i === -1 ? 999 : i;
  };
  return [...rows].sort((a,b) => {
    if(sortKey === 'accuracyDesc'){
      const aa = a.recentAccuracy === null ? -1 : a.recentAccuracy;
      const bb = b.recentAccuracy === null ? -1 : b.recentAccuracy;
      if(bb !== aa) return bb - aa;
      return b.attempts - a.attempts;
    }
    if(sortKey === 'accuracyAsc'){
      const aa = a.recentAccuracy === null ? 2 : a.recentAccuracy;
      const bb = b.recentAccuracy === null ? 2 : b.recentAccuracy;
      if(aa !== bb) return aa - bb;
      return b.attempts - a.attempts;
    }
    if(sortKey === 'highAccuracy'){
      const aa = a.recentAccuracy === null ? -1 : a.recentAccuracy;
      const bb = b.recentAccuracy === null ? -1 : b.recentAccuracy;
      if(bb !== aa) return bb - aa;
      return b.attempts - a.attempts;
    }
    if(sortKey === 'recent'){
      const at = a.record?.lastAnsweredAt ? new Date(a.record.lastAnsweredAt).getTime() : 0;
      const bt = b.record?.lastAnsweredAt ? new Date(b.record.lastAnsweredAt).getTime() : 0;
      return bt - at;
    }
    const cr = categoryRank(a.q.category) - categoryRank(b.q.category);
    if(cr !== 0) return cr;
    return a.q.id.localeCompare(b.q.id);
  });
}

function renderStatusBoard(){
  if(!$('statusBoardList')) return;
  const selectedCategory = $('statusCategoryFilter')?.value || 'all';
  const selectedType = $('statusTypeFilter')?.value || 'all';
  const selectedSort = $('statusSortSelect')?.value || 'category';
  const allRows = getStatusRows();

  renderStatusSummary(allRows);
  updateStatusTabs();

  let rows = allRows.filter(row => selectedCategory === 'all' || row.q.category === selectedCategory);
  rows = rows.filter(row => passesStatusTab(row));
  rows = rows.filter(row => passesStatusFilter(row, selectedType));
  rows = sortStatusRows(rows, selectedSort);

  const totalMatched = rows.length;
  const visibleRows = rows.slice(0, statusVisibleCount);
  const hiddenCount = Math.max(0, totalMatched - visibleRows.length);

  $('statusResultInfo').innerHTML = `<strong>${totalMatched}問</strong>中 <strong>${visibleRows.length}問</strong>を表示中${hiddenCount ? `（残り${hiddenCount}問）` : ''}`;
  $('statusMoreBtn').style.display = hiddenCount ? 'inline-flex' : 'none';
  $('statusShowAllBtn').style.display = hiddenCount ? 'inline-flex' : 'none';

  if(rows.length === 0){
    $('statusBoardList').innerHTML = '<p class="message">条件に合う問題はありません。</p>';
    return;
  }

  const groups = visibleRows.reduce((acc, row) => {
    const groupName = selectedType === 'all'
      ? (row.attempts === 0 ? 'まだやっていない問題' : `${row.status.medal ? row.status.medal + ' ' : ''}${row.status.label}`)
      : (row.q.category);
    acc[groupName] ||= [];
    acc[groupName].push(row);
    return acc;
  }, {});

  const groupOrder = ['🥇 直近10回 90％以上', '🥈 直近10回 70％以上', '🥉 直近10回 50％以上', '直近10回 50％未満', '直近1回・10回未満', '直近2回・10回未満', '直近3回・10回未満', '直近4回・10回未満', '直近5回・10回未満', '直近6回・10回未満', '直近7回・10回未満', '直近8回・10回未満', '直近9回・10回未満', 'まだやっていない問題'];
  const groupNames = Object.keys(groups).sort((a,b) => {
    const ai = groupOrder.indexOf(a);
    const bi = groupOrder.indexOf(b);
    if(ai !== -1 || bi !== -1) return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
    const ca = CATEGORY_ORDER.indexOf(a);
    const cb = CATEGORY_ORDER.indexOf(b);
    if(ca !== -1 || cb !== -1) return (ca === -1 ? 999 : ca) - (cb === -1 ? 999 : cb);
    return a.localeCompare(b, 'ja');
  });

  $('statusBoardList').innerHTML = groupNames.map(group => {
    const cards = groups[group].map(row => {
      const q = row.q;
      const rate = getQuestionAccuracy(row.record);
      const recentRate = row.recentAttempts ? `${Math.round((row.recentAccuracy || 0) * 100)}%` : '--%';
      const doneLabel = row.attempts ? '学習済み' : '未実施';
      const medal = row.status.medal ? `<span class="medal-icon" aria-label="${row.status.label}">${row.status.medal}</span>` : '';
      const lastAnswered = formatDateTime(row.record?.lastAnsweredAt) || '-';
      return `<article class="status-question-card ${row.status.className}">
        <div class="status-question-head">
          <span class="status-medal-wrap">${medal}<span class="status-badge ${row.attempts ? 'done' : 'untried'}">${doneLabel}</span></span>
          <span class="status-rate" title="累計正答率 ${rate}">直近${row.recentAttempts}回 ${recentRate}</span>
        </div>
        <p class="status-question-text"><span class="question-id">${escapeHtml(q.id)}</span>${escapeHtml(q.question)}</p>
        <div class="status-meta">
          <span>${escapeHtml(q.category)}</span>
          <span>${DIFFICULTY_LABELS[q.difficulty] || q.difficulty}</span>
          <span>正答 ${row.correct} / ${row.attempts}</span>
          <span>最終 ${lastAnswered}</span>
        </div>
      </article>`;
    }).join('');
    return `<details class="status-group" open>
      <summary>${escapeHtml(group)}（${groups[group].length}問）</summary>
      <div class="status-card-grid">${cards}</div>
    </details>`;
  }).join('');
}

function getHistoryAdvice(row){
  if(row.attempts === 0) return { label:'未学習', className:'untried', text:'まだ解いていません' };
  if(row.record?.lastCorrect === false) return { label:'要復習', className:'wrong', text:'直近で誤答' };
  if((row.accuracy ?? 1) < 0.7) return { label:'弱点', className:'low', text:'正答率70％未満' };
  if((row.confidenceCounts.guess || 0) > 0 || row.record?.lastConfidence === 'guess') return { label:'確認', className:'guess', text:'勘で解いた記録あり' };
  if((row.accuracy ?? 0) >= 0.9 && row.attempts >= 2) return { label:'定着', className:'mastered', text:'よく定着' };
  return { label:'学習済み', className:'done', text:'継続して確認' };
}

function renderHistorySummary(rows){
  const learned = rows.filter(r=>r.attempts > 0).length;
  const untried = rows.length - learned;
  const wrong = rows.filter(r=>r.attempts > 0 && r.record?.lastCorrect === false).length;
  const low = rows.filter(r=>r.attempts > 0 && (r.accuracy ?? 1) < 0.7).length;
  const mastered = rows.filter(r=>r.attempts >= 2 && (r.accuracy ?? 0) >= 0.9).length;
  const medalRows = getStatusRows();
  const gold = medalRows.filter(r => r.status.key === 'gold').length;
  const silver = medalRows.filter(r => r.status.key === 'silver').length;
  const bronze = medalRows.filter(r => r.status.key === 'bronze').length;
  const totalAttempts = rows.reduce((sum, r) => sum + r.attempts, 0);
  const totalCorrect = rows.reduce((sum, r) => sum + r.correct, 0);
  const overallRate = totalAttempts ? Math.round(totalCorrect / totalAttempts * 100) + '%' : '--%';
  const progressRate = rows.length ? Math.round(learned / rows.length * 100) : 0;

  $('historySummary').innerHTML = `
    <div class="history-overview-card primary">
      <span>学習進捗</span>
      <strong>${learned} / ${rows.length}問</strong>
      <em>${progressRate}％完了</em>
    </div>
    <div class="history-overview-card">
      <span>全体正答率</span>
      <strong>${overallRate}</strong>
      <em>${totalCorrect} / ${totalAttempts}</em>
    </div>
    <button class="history-overview-card danger" type="button" data-history-filter="low">
      <span>要復習</span>
      <strong>${wrong + low}問</strong>
      <em>直近誤答 ${wrong}問・低正答率 ${low}問</em>
    </button>
    <button class="history-overview-card" type="button" data-history-filter="untried">
      <span>未学習</span>
      <strong>${untried}問</strong>
      <em>次に取り組む候補</em>
    </button>
    <button class="history-overview-card medal" type="button" data-history-filter="medals">
      <span>メダル</span>
      <strong>🥇${gold} 🥈${silver} 🥉${bronze}</strong>
      <em>定着状況の目安</em>
    </button>
  `;
  document.querySelectorAll('[data-history-filter]').forEach(btn => {
    btn.addEventListener('click', () => {
      const filter = btn.dataset.historyFilter || 'all';
      if($('historyStatusFilter')) $('historyStatusFilter').value = filter;
      resetHistoryPage();
      updateHistoryQuickTabs();
      renderQuestionHistory();
    });
  });
}

function passesHistoryFilter(row, filter){
  if(filter === 'wrong') return row.attempts > 0 && row.record?.lastCorrect === false;
  if(filter === 'untried') return row.attempts === 0;
  if(filter === 'low') return row.attempts > 0 && (row.accuracy ?? 1) < 0.7;
  if(filter === 'medals') return ['gold', 'silver', 'bronze'].includes(getAccuracyStatus(row).key);
  if(filter === 'gold') return getAccuracyStatus(row).key === 'gold';
  if(filter === 'silver') return getAccuracyStatus(row).key === 'silver';
  if(filter === 'bronze') return getAccuracyStatus(row).key === 'bronze';
  if(filter === 'guess') return (row.confidenceCounts.guess || 0) > 0 || row.record?.lastConfidence === 'guess';
  if(filter === 'selfIncorrect') return (row.confidenceCounts.incorrect || 0) > 0 || row.record?.lastConfidence === 'incorrect';
  return true;
}

function sortHistoryRows(rows, sortKey){
  const categoryRank = (cat) => {
    const i = CATEGORY_ORDER.indexOf(cat);
    return i === -1 ? 999 : i;
  };
  return [...rows].sort((a,b) => {
    if(sortKey === 'lowAccuracy'){
      const aa = a.accuracy === null ? 2 : a.accuracy;
      const bb = b.accuracy === null ? 2 : b.accuracy;
      if(aa !== bb) return aa - bb;
      return b.attempts - a.attempts;
    }
    if(sortKey === 'highAccuracy'){
      const aa = a.recentAccuracy === null ? -1 : a.recentAccuracy;
      const bb = b.recentAccuracy === null ? -1 : b.recentAccuracy;
      if(bb !== aa) return bb - aa;
      return b.attempts - a.attempts;
    }
    if(sortKey === 'recent'){
      const at = a.record?.lastAnsweredAt ? new Date(a.record.lastAnsweredAt).getTime() : 0;
      const bt = b.record?.lastAnsweredAt ? new Date(b.record.lastAnsweredAt).getTime() : 0;
      return bt - at;
    }
    if(sortKey === 'attempts'){
      return b.attempts - a.attempts;
    }
    const cr = categoryRank(a.q.category) - categoryRank(b.q.category);
    if(cr !== 0) return cr;
    return a.q.id.localeCompare(b.q.id);
  });
}


function getVisibleHistoryRows(){
  const selectedCategory = $('historyCategoryFilter')?.value || 'all';
  const selectedDifficulty = $('historyDifficultyFilter')?.value || 'all';
  const selectedCalculation = $('historyCalculationFilter')?.value || 'all';
  const selectedFilter = $('historyStatusFilter')?.value || 'all';
  const selectedSort = $('historySortSelect')?.value || 'category';
  const keyword = ($('historySearchInput')?.value || '').trim().toLowerCase();
  let rows = getHistoryRows().filter(row => selectedCategory === 'all' || row.q.category === selectedCategory);
  rows = rows.filter(row => selectedDifficulty === 'all' || row.q.difficulty === selectedDifficulty);
  rows = rows.filter(row => passesCalculationMode(row.q, selectedCalculation));
  rows = rows.filter(row => passesHistoryFilter(row, selectedFilter));
  if(keyword){
    rows = rows.filter(row => {
      const haystack = `${row.q.id} ${row.q.question} ${row.q.category} ${DIFFICULTY_LABELS[row.q.difficulty] || row.q.difficulty}`.toLowerCase();
      return haystack.includes(keyword);
    });
  }
  return sortHistoryRows(rows, selectedSort);
}

function getCurrentHistoryPageRows(){
  return historyPageRows.length ? historyPageRows : getVisibleHistoryRows().slice(0, HISTORY_PAGE_SIZE);
}

function resetHistoryPage(){
  historyCurrentPage = 1;
}

function renderHistoryPagination(totalRows, totalPages){
  if(totalRows <= HISTORY_PAGE_SIZE) return '';
  const current = Math.min(Math.max(historyCurrentPage, 1), totalPages);
  return `<nav class="history-pagination" aria-label="記録確認ページ送り">
    <button type="button" class="ghost history-page-btn" data-history-page="prev" ${current <= 1 ? 'disabled' : ''}>前の10件</button>
    <span><strong>${current}</strong> / ${totalPages}ページ</span>
    <button type="button" class="ghost history-page-btn" data-history-page="next" ${current >= totalPages ? 'disabled' : ''}>次の10件</button>
  </nav>`;
}

function attachHistoryPaginationEvents(totalPages){
  document.querySelectorAll('.history-page-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const action = btn.dataset.historyPage;
      if(action === 'prev') historyCurrentPage = Math.max(1, historyCurrentPage - 1);
      if(action === 'next') historyCurrentPage = Math.min(totalPages, historyCurrentPage + 1);
      renderQuestionHistory();
      $('historyResultInfo')?.scrollIntoView({ behavior:'smooth', block:'start' });
    });
  });
}

function updateHistorySelectionInfo(visibleCount = null){
  const info = $('historySelectionInfo');
  if(!info) return;
  const visibleText = visibleCount === null ? '' : `・${visibleCount}問表示中`;
  info.textContent = `${selectedQuestionIds.size}問選択中${visibleText}`;
}

function selectVisibleHistoryQuestions(){
  getCurrentHistoryPageRows().forEach(row => selectedQuestionIds.add(row.q.id));
  renderQuestionHistory();
}

function clearHistorySelectedQuestions(){
  selectedQuestionIds.clear();
  renderQuestionHistory();
}

function startHistorySelectedQuestions(){
  const selected = QUESTIONS.filter(q => selectedQuestionIds.has(q.id));
  if(!selected.length){
    const info = $('historySelectionInfo');
    if(info) info.textContent = '問題を1問以上選択してください。';
    return;
  }
  startQuiz({ category:'all', difficulty:'all', count:selected.length, selectedIds:[...selectedQuestionIds] }, selected);
}



function getShortQuestionText(text, max = 90){
  const plain = String(text || '').replace(/\s+/g, ' ').trim();
  return plain.length > max ? plain.slice(0, max) + '…' : plain;
}

function getHistoryCardMetrics({attempts, correct, rate, recentAnalysisRate, recentAnalysisLabel, lastAnswered, selfCheck}){
  if(!attempts){
    return [
      {label:'正答率', value:'未学習'},
      {label:'解答', value:'0回'},
      {label:'最終', value:'—'}
    ];
  }
  return [
    {label:'累計正答率', value:rate},
    {label:recentAnalysisLabel || '直近30回', value:recentAnalysisRate || '—'},
    {label:'正答', value:`${correct}/${attempts}`},
    {label:'最終', value:lastAnswered || '—'},
    {label:'自己', value:selfCheck || '—'}
  ];
}

function updateHistoryQuickTabs(){
  const current = $('historyStatusFilter')?.value || 'all';
  document.querySelectorAll('[data-history-quick]').forEach(btn => {
    btn.classList.toggle('active', (btn.dataset.historyQuick || 'all') === current);
  });
}

function renderQuestionHistory(){
  const allRows = getHistoryRows();

  renderHistorySummary(allRows);

  const rows = getVisibleHistoryRows();
  const totalPages = Math.max(1, Math.ceil(rows.length / HISTORY_PAGE_SIZE));
  historyCurrentPage = Math.min(Math.max(historyCurrentPage, 1), totalPages);
  const startIndex = (historyCurrentPage - 1) * HISTORY_PAGE_SIZE;
  const endIndex = startIndex + HISTORY_PAGE_SIZE;
  const pageRows = rows.slice(startIndex, endIndex);
  historyPageRows = pageRows;
  updateHistorySelectionInfo(pageRows.length);

  const selectedCategory = $('historyCategoryFilter')?.value || 'all';
  const selectedDifficulty = $('historyDifficultyFilter')?.value || 'all';
  const selectedCalculation = $('historyCalculationFilter')?.value || 'all';
  const selectedStatus = $('historyStatusFilter')?.value || 'all';
  const calculationLabel = selectedCalculation === 'only' ? '計算問題のみ' : selectedCalculation === 'exclude' ? '計算問題を除外' : '計算条件なし';
  const filterLabels = [
    selectedCategory === 'all' ? '全分野' : selectedCategory,
    selectedDifficulty === 'all' ? '全難易度' : (DIFFICULTY_LABELS[selectedDifficulty] || selectedDifficulty),
    calculationLabel,
    selectedStatus === 'all' ? '全状態' : ($('historyStatusFilter')?.selectedOptions?.[0]?.textContent || selectedStatus)
  ];
  const rangeText = rows.length ? `${startIndex + 1}〜${Math.min(endIndex, rows.length)}件目を表示` : '0件';
  $('historyResultInfo').innerHTML = `<strong>${rows.length}問</strong><span>${filterLabels.map(escapeHtml).join(' / ')}</span><em>${rangeText}。10件ずつ表示します。</em>`;

  if(rows.length === 0){
    historyPageRows = [];
    $('questionHistory').innerHTML = '<p class="message">条件に合う問題はありません。</p>';
    return;
  }

  const groups = pageRows.reduce((acc, row) => {
    acc[row.q.category] ||= [];
    acc[row.q.category].push(row);
    return acc;
  }, {});

  const categories = getOrderedCategories(groups);
  const byCategoryHtml = categories.map(cat => {
    const items = groups[cat];
    const cardsHtml = items.map((historyRow) => {
      const {q, record, attempts, correct, accuracy, confidenceCounts} = historyRow;
      const lastLabel = getQuestionResultLabel(record);
      const rate = getQuestionAccuracy(record);
      const lastAnswered = formatDateTime(record?.lastAnsweredAt) || '-';
      const selfCheck = getDominantSelfCheck(record);
      const row = historyRow;
      const advice = getHistoryAdvice(row);
      const status = getAccuracyStatus(row);
      const medal = status.medal ? `<span class="history-medal-icon ${status.className}" title="${status.label}" aria-label="${status.label}">${status.medal}</span>` : '<span class="history-medal-placeholder" aria-hidden="true">—</span>';
      const rateValue = attempts ? Math.round((accuracy || 0) * 100) : 0;
      const analysisRate = row.analysisRecentAttempts ? Math.round((row.analysisRecentAccuracy || 0) * 100) + '%' : '未学習';
      const analysisLabel = `直近${row.analysisRecentAttempts || 0}回`;
      const difficulty = DIFFICULTY_LABELS[q.difficulty] || q.difficulty;
      const shortQuestion = getShortQuestionText(q.question);
      const metrics = getHistoryCardMetrics({attempts, correct, rate, recentAnalysisRate: analysisRate, recentAnalysisLabel: analysisLabel, lastAnswered, selfCheck});
      const metricHtml = metrics.map(item => `<span><em>${escapeHtml(item.label)}</em><strong>${escapeHtml(item.value)}</strong></span>`).join('');
      return `<article class="history-question-card ${advice.className} ${status.className}">
        <div class="history-card-head">
          <label class="history-select-label">
            <input type="checkbox" class="history-question-check" value="${escapeHtml(q.id)}" ${selectedQuestionIds.has(q.id) ? 'checked' : ''}>
            <span class="history-title-wrap"><span class="question-id">${escapeHtml(q.id)}</span>${medal}</span>
          </label>
          <span class="history-advice-badge ${advice.className}">${advice.label}</span>
        </div>
        <div class="history-question-body">
          <p class="history-question-text" title="${escapeHtml(q.question)}">${escapeHtml(shortQuestion)}</p>
          <div class="history-card-tags">
            <span>${escapeHtml(difficulty)}</span>
            ${q.figureSvg ? '<span>図あり</span>' : ''}
          ${isCalculationQuestion(q) ? '<span>計算</span>' : ''}
            <span>${lastLabel}</span>
          </div>
        </div>
        <div class="history-progress-row" aria-label="過去正答率 ${rate}">
          <div class="history-progress"><i style="width:${rateValue}%"></i></div>
          <strong>${rate}</strong>
        </div>
        <div class="history-metric-grid">${metricHtml}</div>
        <div class="history-card-bottom">
          <p class="history-card-note">${escapeHtml(advice.text)}</p>
          <button type="button" class="ghost history-single-start" data-question-id="${escapeHtml(q.id)}">この問題を解く</button>
        </div>
      </article>`;
    }).join('');
    return `<details class="history-group" open>
      <summary>${escapeHtml(cat)}（${items.length}問）</summary>
      <div class="history-card-grid">${cardsHtml}</div>
    </details>`;
  }).join('');
  const paginationHtml = renderHistoryPagination(rows.length, totalPages);
  $('questionHistory').innerHTML = `${paginationHtml}${byCategoryHtml}${paginationHtml}`;
  attachHistoryPaginationEvents(totalPages);
  document.querySelectorAll('.history-question-check').forEach(check => {
    check.addEventListener('change', () => {
      if(check.checked){
        selectedQuestionIds.add(check.value);
      }else{
        selectedQuestionIds.delete(check.value);
      }
      updateHistorySelectionInfo(rows.length);
    });
  });
  document.querySelectorAll('.history-single-start').forEach(btn => {
    btn.addEventListener('click', () => {
      const question = QUESTIONS.find(q => q.id === btn.dataset.questionId);
      if(question) startQuiz({ category:'all', difficulty:'all', count:1, selectedIds:[question.id] }, [question]);
    });
  });
}

function setSelectOptionLabels(selectEl, labels){
  Array.from(selectEl.options).forEach(option => {
    if(labels[option.value]) option.textContent = labels[option.value];
  });
}

function renderDifficultySelectCounts(){
  const difficultyCounts = getDifficultyCounts();
  setSelectOptionLabels($('difficultySelect'), {
    all: `すべて（${QUESTIONS.length}問）`,
    intro: `${DIFFICULTY_LABELS.intro}（${difficultyCounts.intro || 0}問）`,
    basic: `${DIFFICULTY_LABELS.basic}（${difficultyCounts.basic || 0}問）`,
    standard: `${DIFFICULTY_LABELS.standard}（${difficultyCounts.standard || 0}問）`,
    advanced: `${DIFFICULTY_LABELS.advanced}（${difficultyCounts.advanced || 0}問）`
  });
}

function renderDifficultyBreakdownForCategory(category, categoryDifficultyCounts){
  const counts = categoryDifficultyCounts[category] || {};
  return Object.keys(DIFFICULTY_LABELS).map(level => {
    return `<span class="difficulty-chip difficulty-${level}"><b>${DIFFICULTY_LABELS[level]}</b><em>${counts[level] || 0}問</em></span>`;
  }).join('');
}

function getCategoryIcon(category){
  const icons = {
    "情報社会と法": "🌐",
    "情報デザイン": "🎨",
    "コンピュータの仕組み": "💻",
    "プログラミング": "🧩",
    "ネットワークとセキュリティ": "🔐",
    "データ活用": "📊"
  };
  return icons[category] || "📘";
}

function getTodayKey(){
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth()+1).padStart(2,'0');
  const day = String(d.getDate()).padStart(2,'0');
  return `${y}-${m}-${day}`;
}

function getRequestedCount(value, poolLength){
  if(value === 'all') return poolLength;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.min(n, poolLength) : poolLength;
}

function getSavedLastConfig(){
  try{
    const saved = JSON.parse(localStorage.getItem(LAST_CONFIG_KEY) || 'null');
    if(saved && typeof saved === 'object') return saved;
  }catch(e){}
  return { category:'all', difficulty:'all', count:10 };
}

function saveLastConfig(config){
  localStorage.setItem(LAST_CONFIG_KEY, JSON.stringify(config));
}

function formatCountLabel(count){
  return count === 'all' ? 'すべて' : `${count}問`;
}

function getWeakRows(limit = 5){
  const stats = loadStats();
  const rows = QUESTIONS.map(q => {
    const r = stats.questionStats[q.id];
    const attempts = r?.attempts || 0;
    const correct = r?.correct || 0;
    const accuracy = attempts ? correct / attempts : null;
    const weakStats = getWeakAnswerStats(r, MEDAL_RECENT_LIMIT);
    const isWeak = weakStats.attempts > 0 && (weakStats.accuracy ?? 1) < 0.7;
    return {
      q,
      record:r,
      attempts,
      correct,
      accuracy,
      weakAttempts: weakStats.attempts,
      weakCorrect: weakStats.correct,
      weakAccuracy: weakStats.accuracy,
      weakSource: weakStats.source,
      isWeak
    };
  }).filter(row => row.isWeak);
  return rows.sort((a,b) => {
    const aa = a.weakAccuracy ?? 1;
    const bb = b.weakAccuracy ?? 1;
    if(aa !== bb) return aa - bb;
    return b.weakAttempts - a.weakAttempts;
  }).slice(0, limit);
}

function renderTodayStats(){
  const stats = loadStats();
  const today = stats.daily?.[getTodayKey()] || {sessions:0, answered:0, correct:0};
  const rate = today.answered ? Math.round(today.correct / today.answered * 100) + '%' : '--%';
  const message = today.answered
    ? `今日は ${today.answered}問 解いています。短時間でも継続できています。`
    : '今日はまだ学習記録がありません。まずは5問から始めましょう。';
  $('todayStats').innerHTML = `
    <div class="today-pill"><span>今日の回数</span><strong>${today.sessions || 0}</strong></div>
    <div class="today-pill"><span>今日の解答数</span><strong>${today.answered || 0}</strong></div>
    <div class="today-pill"><span>今日の正答率</span><strong>${rate}</strong></div>
    <p class="today-message">${message}</p>
  `;
}

function renderNextLearningBox(){
  const weakRows = getWeakRows(5);
  const last = getSavedLastConfig();
  const lastText = `${last.category === 'all' ? '全分野' : last.category}／${last.difficulty === 'all' ? '全難易度' : (DIFFICULTY_LABELS[last.difficulty] || last.difficulty)}／${formatCountLabel(last.count)}`;
  const weakHtml = weakRows.length
    ? `<div class="weak-list">${weakRows.map(r => `<span class="weak-chip">${r.q.category} ${getWeakLabel(r)}</span>`).join('')}</div>`
    : '<span>現在、目立った苦手問題はありません。</span>';
  $('nextLearningBox').innerHTML = `
    <div class="next-action">
      <div><strong>前回の続きから学習</strong><span>${lastText} の未学習問題を優先します。</span></div>
      <button id="continueLearningBtn" class="primary next-cta continue-btn" type="button">▶ 続きから学習</button>
    </div>
    <div class="next-action">
      <div><strong>苦手問題</strong>${weakHtml}</div>
      <button id="startWeakBtn" class="next-cta weak-btn" type="button" ${weakRows.length ? '' : 'disabled'}>★ 苦手問題を復習</button>
    </div>
  `;
  $('continueLearningBtn').addEventListener('click', startContinueLearning);
  $('startWeakBtn').addEventListener('click', startWeakReview);
}

function getCategoryProgress(category){
  const stats = loadStats();
  const list = QUESTIONS.filter(q => q.category === category);
  const learned = list.filter(q => (stats.questionStats[q.id]?.attempts || 0) > 0).length;
  const total = list.length;
  const percent = total ? Math.round(learned / total * 100) : 0;
  return { learned, total, percent };
}

function startContinueLearning(){
  const config = getSavedLastConfig();
  const stats = loadStats();
  const pool = getFilteredQuestions(config);
  const untried = pool.filter(q => !(stats.questionStats[q.id]?.attempts));
  const selectedPool = untried.length ? untried : pool;
  startQuiz(config, selectedPool);
}

function startWeakReview(){
  const weak = getWeakRows(20).map(r => r.q);
  if(!weak.length){ $('homeMessage').textContent = '復習対象の苦手問題はありません。'; return; }
  startQuiz({ category:'all', difficulty:'all', count:Math.min(10, weak.length) }, weak);
}

function openGuide(){ $('guideModal')?.classList.remove('hidden'); }
function closeGuide(){ $('guideModal')?.classList.add('hidden'); }

function applyTutorialVisibility(){
  const tutorial = $('firstTutorial');
  if(!tutorial) return;
  const isHidden = localStorage.getItem(TUTORIAL_HIDDEN_KEY) === 'true';
  tutorial.classList.toggle('hidden', isHidden);
  tutorial.hidden = isHidden;
  tutorial.setAttribute('aria-hidden', isHidden ? 'true' : 'false');
}

function hideFirstTutorial(){
  localStorage.setItem(TUTORIAL_HIDDEN_KEY, 'true');
  applyTutorialVisibility();
}


function escapeHtml(value){
  return String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
}

function formatUpdateDate(value){
  if(!value) return '';
  const parts = String(value).split('-');
  if(parts.length === 3) return `${parts[0]}年${Number(parts[1])}月${Number(parts[2])}日`;
  return value;
}

function renderUpdateHistory(updates){
  const list = $('updateHistoryList');
  const message = $('updateHistoryMessage');
  const badge = $('updatesLatestBadge');
  if(!list) return;

  const normalized = Array.isArray(updates) ? updates : [];
  const sorted = normalized
    .filter(item => item && (item.title || item.version || item.date))
    .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')))
    .slice(0, UPDATE_HISTORY_LIMIT);

  if(!sorted.length){
    list.innerHTML = '<div class="update-empty">更新履歴はまだ登録されていません。</div>';
    if(message) message.textContent = '';
    if(badge) badge.textContent = '0件';
    return;
  }

  list.innerHTML = sorted.map((item, index) => {
    const itemList = Array.isArray(item.items) ? item.items : [];
    const newBadge = item.isNew || index === 0 ? '<span class="update-new">NEW</span>' : '';
    const itemsHtml = itemList.length
      ? `<ul>${itemList.map(text => `<li>${escapeHtml(text)}</li>`).join('')}</ul>`
      : '';
    return `
      <article class="update-item">
        <div class="update-item-head">
          <div>
            <div class="update-meta">
              ${newBadge}
              <span>${escapeHtml(item.version || '')}</span>
              <span>${escapeHtml(formatUpdateDate(item.date))}</span>
            </div>
            <h3>${escapeHtml(item.title || '更新')}</h3>
          </div>
        </div>
        ${itemsHtml}
      </article>
    `;
  }).join('');

  if(message) message.textContent = `最新${sorted.length}件を表示しています。`;
  if(badge) badge.textContent = `${escapeHtml(sorted[0].version || '最新版')} / ${escapeHtml(formatUpdateDate(sorted[0].date))}`;
}

async function loadUpdateHistory(){
  const list = $('updateHistoryList');
  const message = $('updateHistoryMessage');
  const badge = $('updatesLatestBadge');
  if(list) list.innerHTML = '<div class="update-empty">更新履歴を読み込んでいます。</div>';
  if(message) message.textContent = '';
  if(badge) badge.textContent = '読み込み中';

  try{
    const response = await fetch(UPDATE_HISTORY_URL, { cache: 'no-store' });
    if(!response.ok) throw new Error(`HTTP ${response.status}`);
    const updates = await response.json();
    renderUpdateHistory(updates);
  }catch(error){
    if(list) list.innerHTML = '<div class="update-empty">更新履歴を読み込めませんでした。GitHub Pages上で確認するか、update-history.json を確認してください。</div>';
    if(message) message.textContent = 'ローカルで直接HTMLを開いている場合、ブラウザの制限でJSONを読み込めないことがあります。';
    if(badge) badge.textContent = '読み込み失敗';
  }
}

function openUpdates(){
  showPanel('updatesPanel');
  loadUpdateHistory();
}


function init(){
  applyTutorialVisibility();
  renderStudentProfileBox();
  const categoryCounts = getCategoryCounts();
  const categories = getOrderedCategories(categoryCounts);
  categories.forEach(cat => {
    const opt = document.createElement('option');
    opt.value = cat;
    opt.textContent = `${cat}（${categoryCounts[cat]}問）`;
    $('categorySelect').appendChild(opt);

    const historyOpt = document.createElement('option');
    historyOpt.value = cat;
    historyOpt.textContent = `${cat}（${categoryCounts[cat]}問）`;
    $('historyCategoryFilter').appendChild(historyOpt);

    if($('statusCategoryFilter')){
      const statusOpt = document.createElement('option');
      statusOpt.value = cat;
      statusOpt.textContent = `${cat}（${categoryCounts[cat]}問）`;
      $('statusCategoryFilter').appendChild(statusOpt);
    }
  });
  renderDifficultySelectCounts();
  $('totalQuestions').textContent = QUESTIONS.length;
  $('startBtn').addEventListener('click', startFromFilters);
  $('saveStudentProfileBtn')?.addEventListener('click', saveStudentProfileFromForm);
  $('resetStudentProfileBtn')?.addEventListener('click', resetStudentProfileForCorrection);
  $('resendLogsBtn')?.addEventListener('click', flushPendingLearningLogs);
  $('categorySelect').addEventListener('change', () => { renderQuestionPicker(); renderQuestionHistory(); });
  $('difficultySelect').addEventListener('change', () => { renderQuestionPicker(); renderQuestionHistory(); });
  $('calculationSelect').addEventListener('change', () => { renderQuestionPicker(); renderQuestionHistory(); });
  if($('selectAllVisibleBtn')) $('selectAllVisibleBtn').addEventListener('click', selectAllVisibleQuestions);
  if($('clearSelectedBtn')) $('clearSelectedBtn').addEventListener('click', clearSelectedQuestions);
  if($('startSelectedBtn')) $('startSelectedBtn').addEventListener('click', startSelectedQuestions);
  $('historySelectVisibleBtn').addEventListener('click', selectVisibleHistoryQuestions);
  $('historyClearSelectedBtn').addEventListener('click', clearHistorySelectedQuestions);
  $('historyStartSelectedBtn').addEventListener('click', startHistorySelectedQuestions);
  $('reviewWrongBtn').addEventListener('click', startWrongReview);
  $('openGuideBtn').addEventListener('click', openGuide);
  $('openUpdatesBtn')?.addEventListener('click', openUpdates);
  $('updatesBackBtn')?.addEventListener('click', ()=>{showPanel('home');});
  $('reloadUpdatesBtn')?.addEventListener('click', loadUpdateHistory);
  $('closeGuideBtn').addEventListener('click', closeGuide);
  $('closeGuideBackdrop').addEventListener('click', closeGuide);
  if($('hideTutorialBtn')) $('hideTutorialBtn').addEventListener('click', hideFirstTutorial);
  $('resetStatsBtn').addEventListener('click', resetStats);
  $('openHistoryBtn').addEventListener('click', ()=>{renderQuestionHistory(); showPanel('history');});
  $('historyBackBtn').addEventListener('click', ()=>{showPanel('home');});
  $('historyCategoryFilter').addEventListener('change', () => { resetHistoryPage(); renderQuestionHistory(); });
  $('historyDifficultyFilter').addEventListener('change', () => { resetHistoryPage(); renderQuestionHistory(); });
  $('historyCalculationFilter').addEventListener('change', () => { resetHistoryPage(); renderQuestionHistory(); });
  $('historyStatusFilter').addEventListener('change', () => { resetHistoryPage(); updateHistoryQuickTabs(); renderQuestionHistory(); });
  $('historySortSelect').addEventListener('change', () => { resetHistoryPage(); renderQuestionHistory(); });
  $('historySearchInput').addEventListener('input', () => { resetHistoryPage(); renderQuestionHistory(); });
  document.querySelectorAll('[data-history-quick]').forEach(btn => {
    btn.addEventListener('click', () => {
      $('historyStatusFilter').value = btn.dataset.historyQuick || 'all';
      updateHistoryQuickTabs();
      renderQuestionHistory();
    });
  });
  $('backHomeBtn').addEventListener('click', () => { renderHome(); showPanel('home'); });
  $('backHistoryBtn').addEventListener('click', () => { renderQuestionHistory(); showPanel('history'); });
  $('toHomeBtn').addEventListener('click', () => { renderHome(); showPanel('home'); });
  $('retryBtn').addEventListener('click', () => startQuiz(lastConfig));
  $('reviewSessionWrongBtn').addEventListener('click', startSessionWrongReview);
  $('nextBtn').onclick = nextQuestion;
  document.querySelectorAll('.confidence-choice').forEach(btn => btn.addEventListener('click', () => setConfidence(btn.dataset.confidence)));
  renderHome();
}

function renderHome(){
  renderStudentProfileBox();
  const stats = loadStats();
  $('studyCount').textContent = stats.sessions;
  $('totalAccuracy').textContent = stats.answered ? Math.round(stats.correct / stats.answered * 100) + '%' : '--%';
  renderTodayStats();
  renderNextLearningBox();
  renderQuestionPicker();
  const qp=loadQuizProgress();
  if(qp && qp.sessionQuestions?.length){ $('homeMessage').innerHTML='前回の学習途中データがあります。'; }
  const categoryCounts = getCategoryCounts();
  const categoryDifficultyCounts = getCategoryDifficultyCounts();
  const cats = getOrderedCategories(categoryCounts);
  $('categoryStats').innerHTML = cats.map(cat => {
    const s = stats.byCategory[cat] || {answered:0, correct:0};
    const rate = s.answered ? Math.round(s.correct / s.answered * 100) + '%' : '--%';
    const difficultyBreakdown = renderDifficultyBreakdownForCategory(cat, categoryDifficultyCounts);
    const progress = getCategoryProgress(cat);
    return `<article class="category-card">
      <div class="category-card-head">
        <div class="category-title"><span class="category-icon" aria-hidden="true">${getCategoryIcon(cat)}</span><strong>${cat}</strong></div>
        <span class="category-count">${categoryCounts[cat]}問</span>
      </div>
      <div class="category-meta"><span>学習済み ${progress.learned}/${progress.total}問</span><span>未学習 ${progress.total - progress.learned}問</span></div>
      <div class="difficulty-breakdown">${difficultyBreakdown}</div>
      <div class="category-progress-row">
        <span>学習達成率 ${progress.percent}%</span>
        <span>正答率 ${rate}</span>
      </div>
      <div class="progress-track" aria-label="${cat}の達成率"><div class="progress-fill" style="width:${progress.percent}%"></div></div>
    </article>`;
  }).join('');
  renderQuestionHistory();
}

function getFilteredQuestions(config){
  if(config.selectedIds?.length){
    const selectedSet = new Set(config.selectedIds);
    return QUESTIONS.filter(q => selectedSet.has(q.id));
  }
  const calculationMode = config.calculation || 'all';
  return QUESTIONS.filter(q =>
    (config.category === 'all' || q.category === config.category) &&
    (config.difficulty === 'all' || q.difficulty === config.difficulty) &&
    passesCalculationMode(q, calculationMode)
  );
}

function getCurrentFilterConfig(){
  return {
    category: $('categorySelect').value,
    difficulty: $('difficultySelect').value,
    calculation: $('calculationSelect')?.value || 'all',
    count: $('countSelect').value === 'all' ? 'all' : Number($('countSelect').value)
  };
}

function renderQuestionPicker(){
  const listEl = $('questionPickerList');
  if(!listEl) return;
  const stats = loadStats();
  const config = getCurrentFilterConfig();
  const questions = getFilteredQuestions(config);
  const selectedVisibleCount = questions.filter(q => selectedQuestionIds.has(q.id)).length;
  if($('questionPickerInfo')) $('questionPickerInfo').textContent = `${questions.length}問表示中・${selectedQuestionIds.size}問選択中`;
  if(!questions.length){
    listEl.innerHTML = '<p class="message">条件に合う問題がありません。</p>';
    return;
  }
  listEl.innerHTML = questions.map((q, index) => {
    const record = stats.questionStats[q.id];
    const attempts = record?.attempts || 0;
    const rate = attempts ? Math.round(record.correct / attempts * 100) + '%' : '未学習';
    const last = record?.lastCorrect === true ? '直近 正解' : record?.lastCorrect === false ? '直近 不正解' : '未実施';
    const checked = selectedQuestionIds.has(q.id) ? 'checked' : '';
    const safeQuestion = escapeHtml(q.question);
    return `<label class="question-pick-item">
      <input type="checkbox" class="question-pick-check" value="${escapeHtml(q.id)}" ${checked}>
      <span class="question-pick-main">
        <span class="question-pick-title"><span class="question-number">${index + 1}</span>${safeQuestion}</span>
        <span class="question-pick-meta">
          <span>${escapeHtml(q.category)}</span>
          <span>${DIFFICULTY_LABELS[q.difficulty] || q.difficulty}</span>
          <span>${rate}</span>
          <span>${last}</span>
          ${q.figureSvg ? '<span>図あり</span>' : ''}
        </span>
      </span>
    </label>`;
  }).join('');
  listEl.querySelectorAll('.question-pick-check').forEach(check => {
    check.addEventListener('change', () => {
      if(check.checked){
        selectedQuestionIds.add(check.value);
      }else{
        selectedQuestionIds.delete(check.value);
      }
      if($('questionPickerInfo')) $('questionPickerInfo').textContent = `${questions.length}問表示中・${selectedQuestionIds.size}問選択中`;
    });
  });
}

function selectAllVisibleQuestions(){
  getFilteredQuestions(getCurrentFilterConfig()).forEach(q => selectedQuestionIds.add(q.id));
  renderQuestionPicker();
}

function clearSelectedQuestions(){
  selectedQuestionIds.clear();
  renderQuestionPicker();
}

function startSelectedQuestions(){
  const selected = QUESTIONS.filter(q => selectedQuestionIds.has(q.id));
  if(!selected.length){
    $('homeMessage').textContent = '解きたい問題を1問以上選んでください。';
    return;
  }
  startQuiz({ category:'all', difficulty:'all', count:selected.length, selectedIds:[...selectedQuestionIds] }, selected);
}

function startFromFilters(){
  startQuiz(getCurrentFilterConfig());
}

function startQuiz(config, customQuestions = null){
  const pool = customQuestions || getFilteredQuestions(config);
  if(pool.length === 0){ $('homeMessage').textContent = '条件に合う問題がありません。'; return; }
  lastConfig = config;
  saveLastConfig(config);
  const requestedCount = getRequestedCount(config.count, pool.length);
  sessionQuestions = shuffle(pool).slice(0, requestedCount).map(randomizeChoices);
  currentIndex = 0;
  sessionAnswers = [];
  sessionStartedAt = new Date().toISOString();
  $('homeMessage').textContent = '';
  showPanel('quiz');
  renderQuestion();
  saveQuizProgress();
}

function renderQuestion(){
  const q = sessionQuestions[currentIndex];
  if($('nextBtn')){
    $('nextBtn').disabled = true;
    $('nextBtn').textContent = '次の問題へ';
  }
  $('feedback').className = 'card feedback hidden';
  resetConfidenceChoices();
  $('progressText').textContent = `問題 ${currentIndex + 1} / ${sessionQuestions.length}`;
  $('progressBar').style.width = `${currentIndex / sessionQuestions.length * 100}%`;
  $('questionCategory').textContent = q.category;
  $('questionDifficulty').textContent = DIFFICULTY_LABELS[q.difficulty];
  $('questionText').textContent = q.question;
  const figure = $('questionFigure');
  if(figure){
    if(q.figureSvg){
      figure.innerHTML = q.figureSvg;
      figure.classList.remove('hidden');
    }else{
      figure.innerHTML = '';
      figure.classList.add('hidden');
    }
  }
  $('choices').innerHTML = q.choices.map((choice, i) => `<button class="choice" data-index="${i}">${i + 1}. ${choice}</button>`).join('');
  document.querySelectorAll('.choice').forEach(btn => btn.addEventListener('click', () => answerQuestion(Number(btn.dataset.index))));
}

function scrollToFeedback(){
  const feedback = $('feedback');
  if(!feedback || feedback.classList.contains('hidden')) return;
  requestAnimationFrame(() => {
    feedback.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
}

function answerQuestion(selected){
  const q = sessionQuestions[currentIndex];
  const correct = selected === q.answer;
  const previousAnswer = sessionAnswers[currentIndex] || {};
  sessionAnswers[currentIndex] = {
    ...previousAnswer,
    id: q.id,
    category: q.category,
    correct,
    selected,
    confidence: previousAnswer.confidence || null
  };
  recordAnsweredQuestionForSync(currentIndex);
  saveQuizProgress();
  document.querySelectorAll('.choice').forEach((btn, i) => {
    btn.disabled = true;
    if(i === q.answer) btn.classList.add('correct');
    if(i === selected && !correct) btn.classList.add('wrong');
  });
  $('feedback').className = `card feedback ${correct ? 'ok' : 'ng'}`;
  $('feedbackTitle').textContent = correct ? '正解！' : '不正解';
  $('correctAnswer').textContent = `正解：${q.choices[q.answer]}`;
  $('explanation').textContent = q.explanation;
  $('nextBtn').textContent = currentIndex + 1 === sessionQuestions.length ? '結果を見る' : '次の問題へ';
  $('nextBtn').disabled = false;
  $('feedback').classList.remove('hidden');
  $('progressBar').style.width = `${(currentIndex + 1) / sessionQuestions.length * 100}%`;
  scrollToFeedback();
}

function resetConfidenceChoices(){
  document.querySelectorAll('.confidence-choice').forEach(btn => {
    btn.classList.remove('selected');
    btn.setAttribute('aria-pressed', 'false');
  });
}

function setConfidence(confidence){
  if(!sessionAnswers[currentIndex]) return;
  sessionAnswers[currentIndex].confidence = confidence;
  document.querySelectorAll('.confidence-choice').forEach(btn => {
    const selected = btn.dataset.confidence === confidence;
    btn.classList.toggle('selected', selected);
    btn.setAttribute('aria-pressed', selected ? 'true' : 'false');
  });
}

function nextQuestion(){
  if(currentIndex + 1 >= sessionQuestions.length){ finishQuiz(); return; }
  currentIndex++;
  saveQuizProgress();
  renderQuestion();
  saveQuizProgress();
}

function finishQuiz(){
  const answered = getAnsweredSessionAnswers();
  if(answered.length === 0){
    lastSyncMessage = '解答がないため、学習記録は送信しませんでした。';
    renderStudentProfileBox();
    showPanel('home');
    return;
  }

  const stats = loadStats();
  stats.sessions++;
  const todayKey = getTodayKey();
  stats.daily ||= {};
  stats.daily[todayKey] ||= {sessions:0, answered:0, correct:0};
  stats.daily[todayKey].sessions++;
  answered.forEach(a => {
    stats.answered++;
    if(a.correct) stats.correct++;
    stats.daily[todayKey].answered++;
    if(a.correct) stats.daily[todayKey].correct++;
    stats.byCategory[a.category] ||= {answered:0, correct:0};
    stats.byCategory[a.category].answered++;
    if(a.correct) stats.byCategory[a.category].correct++;

    stats.questionStats[a.id] ||= { attempts:0, correct:0, lastCorrect:null, lastSelected:null, lastConfidence:null, confidenceCounts:{ confident:0, guess:0, incorrect:0 }, recentAnswers:[], lastAnsweredAt:null };
    const qStat = stats.questionStats[a.id];
    qStat.confidenceCounts ||= { confident:0, guess:0, incorrect:0 };
    qStat.recentAnswers = Array.isArray(qStat.recentAnswers) ? qStat.recentAnswers : [];
    qStat.attempts++;
    if(a.correct) qStat.correct++;
    qStat.lastCorrect = a.correct;
    qStat.lastSelected = a.selected;
    qStat.lastConfidence = a.confidence || null;
    if(a.confidence && qStat.confidenceCounts[a.confidence] !== undefined) qStat.confidenceCounts[a.confidence]++;
    const answeredAt = new Date().toISOString();
    qStat.recentAnswers.push({ correct: a.correct, selected: a.selected, confidence: a.confidence || null, answeredAt });
    qStat.recentAnswers = qStat.recentAnswers.slice(-ANALYSIS_RECENT_LIMIT);
    qStat.lastAnsweredAt = answeredAt;
  });
  const wrongIds = answered.filter(a=>!a.correct).map(a=>a.id);
  stats.wrongIds = [...new Set([...wrongIds, ...stats.wrongIds])].slice(0, WRONG_LIST_LIMIT);
  const correctIds = answered.filter(a=>a.correct).map(a=>a.id);
  stats.wrongIds = stats.wrongIds.filter(id => !correctIds.includes(id));
  saveStats(stats);
  clearQuizProgress();
  renderResult();
  showPanel('result');
}

function renderResult(){
  const correct = sessionAnswers.filter(a=>a.correct).length;
  const total = sessionAnswers.length;
  const rate = Math.round(correct / total * 100);
  $('scoreText').textContent = `${correct} / ${total}問 正解（${rate}%）`;
  $('resultMessage').textContent = rate >= 80 ? 'よくできています。次は標準・発展にも挑戦しましょう。' : rate >= 60 ? '基本はつかめています。間違えた問題を復習しましょう。' : 'まずは解説を読んで、同じ分野をもう一度確認しましょう。';
  const cats = [...new Set(sessionAnswers.map(a=>a.category))];
  $('resultBreakdown').innerHTML = cats.map(cat => {
    const list = sessionAnswers.filter(a=>a.category === cat);
    const c = list.filter(a=>a.correct).length;
    return `<div class="mini-stat"><strong>${cat}</strong><span>${c} / ${list.length}</span></div>`;
  }).join('');
  const confidenceLabels = { confident: '自信あり', guess: '勘', incorrect: '不正解', unselected: '未選択' };
  const confidenceCounts = sessionAnswers.reduce((counts, a) => {
    const key = a.confidence || 'unselected';
    counts[key] = (counts[key] || 0) + 1;
    return counts;
  }, {});
  $('resultBreakdown').insertAdjacentHTML('beforeend', `<div class="mini-stat"><strong>自己チェック</strong><span>自信あり ${confidenceCounts.confident || 0}問</span><span>勘 ${confidenceCounts.guess || 0}問</span><span>不正解 ${confidenceCounts.incorrect || 0}問</span><span>未選択 ${confidenceCounts.unselected || 0}問</span></div>`);
  $('reviewSessionWrongBtn').disabled = correct === total;
}

function startSessionWrongReview(){
  const wrongIds = sessionAnswers.filter(a=>!a.correct).map(a=>a.id);
  const questions = QUESTIONS.filter(q=>wrongIds.includes(q.id));
  if(questions.length) startQuiz({ category:'all', difficulty:'all', count:questions.length }, questions);
}

function startWrongReview(){
  const stats = loadStats();
  const questions = QUESTIONS.filter(q=>stats.wrongIds.includes(q.id));
  if(!questions.length){ $('homeMessage').textContent = '復習対象の問題はありません。'; return; }
  startQuiz({ category:'all', difficulty:'all', count:Math.min(10, questions.length) }, questions);
}

function resetStats(){
  if(confirm('学習記録をリセットしますか？')){ localStorage.removeItem(STORAGE_KEY); renderHome(); }
}

document.addEventListener('DOMContentLoaded', init);
