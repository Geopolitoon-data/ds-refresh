// Stands in for the desktop app's local server (server.py + engine.py) on a static site.
// Same /api/... paths and answers; progress is kept in this browser's localStorage.
"use strict";
const LocalAPI = (() => {
  const KEY = "ds-refresh-progress";
  let D = null;                                  // data.json: content + grading fields
  const loaded = fetch("data.json").then(r => r.json()).then(d => { D = d; });

  // ---------------------------------------------------------------- dates (local calendar day)
  const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const today = () => iso(new Date());
  const plusDays = n => { const d = new Date(); d.setDate(d.getDate() + n); return iso(d); };

  // ---------------------------------------------------------------- progress
  let memory = null;                             // used when the browser blocks storage
  function load() {
    let p = null;
    try { p = JSON.parse(localStorage.getItem(KEY) || "null"); } catch { p = memory; }
    if (!p) p = memory;
    if (!p) p = { start: today(), done: {}, reviews: {}, log: {}, drafts: {}, stats: {}, lessons: {}, more: {} };
    for (const k of ["done", "reviews", "log", "drafts", "stats", "lessons", "more"]) p[k] = p[k] || {};
    return p;
  }
  function save(p) {
    memory = p;
    try { localStorage.setItem(KEY, JSON.stringify(p)); } catch { /* private window: kept for this visit only */ }
  }
  const bump = (p, key) => {
    const day = p.log[today()] ||= { solved: 0, reviewed: 0, correct: 0 };
    day[key] = (day[key] || 0) + 1;
  };
  function markDone(id, attempts = 1, review = true) {
    const p = load();
    if (!p.done[id]) {
      p.done[id] = { date: today(), attempts };
      if (review) p.reviews[id] = { box: 0, due: plusDays(1), seen: [], history: [] };
      bump(p, "solved");
    }
    save(p);
  }
  function recordReview(id, card, correct) {
    const p = load(); const r = p.reviews[id];
    if (!r) return;
    const top = D.intervals.length - 1;
    r.box = correct ? Math.min(r.box + 1, top) : 0;
    r.due = plusDays(D.intervals[r.box]);
    r.seen = r.seen.filter(c => c !== card).concat([card]).slice(-12);
    r.history.push([today(), card, !!correct]);
    bump(p, "reviewed"); if (correct) bump(p, "correct");
    save(p);
  }
  function logAttempt(id, { ok = null, revealed = false, score = null } = {}) {
    const p = load();
    const s = p.stats[id] ||= { tries: 0, fails: 0, revealed: false };
    s.first ||= today(); s.last = today();
    if (ok !== null && ok !== undefined) {
      s.tries += 1; s.fails += ok ? 0 : 1; s.last_ok = !!ok;
      if (ok && !("solved_on_try" in s)) s.solved_on_try = s.tries;
      // the pass right after looking at the solution still counts as "needs work"
      if (ok) { const fresh = s.reveal_fresh; delete s.reveal_fresh; if (!fresh) s.revealed = false; }
    }
    if (revealed) {
      if (!("solved_on_try" in s)) s.helped = true;
      s.revealed = true; s.reveal_fresh = true;
    }
    if (score) { s.scores = (s.scores || []).concat([score]).slice(-10); }
    save(p);
  }
  const markLesson = id => { const p = load(); p.lessons[id] ||= today(); save(p); };
  const markMore = id => { const p = load(); p.more[id] ||= today(); save(p); };
  const saveDraft = (id, code) => { const p = load(); p.drafts[id] = code; save(p); };
  const dueIds = p => Object.keys(p.reviews).filter(i => p.reviews[i].due <= today())
    .sort((a, b) => (p.reviews[a].due < p.reviews[b].due ? -1 : p.reviews[a].due > p.reviews[b].due ? 1 : p.reviews[a].box - p.reviews[b].box));
  function streak(p) {
    const days = new Set(Object.keys(p.log).filter(d => p.log[d].solved || p.log[d].reviewed));
    const d = new Date(); let n = 0;
    if (!days.has(iso(d))) d.setDate(d.getDate() - 1);
    while (days.has(iso(d))) { n++; d.setDate(d.getDate() - 1); }
    return n;
  }
  function state() {
    const p = load();
    const reviews = {};
    for (const [k, v] of Object.entries(p.reviews)) reviews[k] = { box: v.box, due: v.due, seen: v.seen, history: v.history.slice(-20) };
    return {
      today: today(), start: p.start,
      exercises: structuredClone(D.exercises), lessons: D.lessons, saved: D.saved,
      lessons_done: p.lessons, more_done: p.more, stats: p.stats, done: p.done, reviews,
      due: dueIds(p), streak: streak(p), log: p.log, drafts: p.drafts, schema: D.schema,
    };
  }

  // ---------------------------------------------------------------- Python / SQL engine (web worker)
  let worker = null, jobN = 0; const waiting = {};
  function startWorker() {
    worker = new Worker("worker.js");
    worker.onmessage = ({ data }) => {
      if (data.type === "failed") { for (const k in waiting) waiting[k]({ ok: false, error: "Python could not load. Check your connection and reload the page." }); return; }
      if (data.id && waiting[data.id]) { const w = waiting[data.id]; delete waiting[data.id]; w(data.res); }
    };
  }
  startWorker();
  const post = job => new Promise(resolve => { job.id = ++jobN; waiting[job.id] = resolve; worker.postMessage(job); });
  async function exec(job, limitS) {
    await post({ type: "prep", lang: job.lang, code: (job.setup || "") + "\n" + job.code });
    return new Promise(resolve => {
      job.type = "run"; job.id = ++jobN;
      const timer = setTimeout(() => {           // stuck loop: throw the engine away and start a fresh one
        delete waiting[job.id]; worker.terminate(); startWorker();
        resolve({ ok: false, stdout: "", checks: [], error: `Timed out after ${limitS}s. Look for an infinite loop.` });
      }, limitS * 1000);
      waiting[job.id] = res => { clearTimeout(timer); resolve(res); };
      worker.postMessage(job);
    });
  }
  const runSql = (code, solution = null, ordered = false) =>
    exec({ lang: "sql", seed: D.seed, code, solution, ordered }, 20);
  const runPython = (code, setup = "", checks = [], mode = "run") =>
    exec({ lang: "python", code, setup, checks, mode }, 60);

  // ---------------------------------------------------------------- the /api endpoints
  async function check(body) {
    const ex = D.items[body.id || ""];
    if (!ex) return { ok: false, error: "Unknown exercise." };
    const code = body.code || "";
    const res = ex.kind === "sql" ? await runSql(code, ex.solution, !!ex.ordered)
                                  : await runPython(code, ex.setup || "", ex.checks || [], "check");
    if (ex.id.includes("~") || ex.saved) { if (res.ok) markMore(ex.id); }   // practice only
    else if (!body.review) {
      logAttempt(ex.id, { ok: !!res.ok });
      if (res.ok && !ex.id.includes("#p")) markDone(ex.id, body.attempts || 1, !ex.warmup);
    }
    if (res.ok) Object.assign(res, { solution: ex.solution || "", solution_steps: ex.solution_steps || "", explanation: ex.explanation || "" });
    return res;
  }
  async function call(path, body) {
    await loaded;
    const url = new URL(path, location.href); const q = url.searchParams;
    switch (url.pathname.replace(/^.*\/api\//, "/api/")) {
      case "/api/state": return state();
      case "/api/solution": {
        const ex = D.items[q.get("id") || ""];
        if (!ex) return { error: "Unknown exercise." };
        if (q.get("reveal") && !ex.id.includes("~") && !ex.saved) logAttempt(ex.id, { revealed: true });
        return { solution: ex.solution || "", solution_steps: ex.solution_steps || "", explanation: ex.explanation || "" };
      }
      case "/api/run": {
        if (body.lang === "sql") return runSql(body.code || "");
        return runPython(body.code || "", (D.items[body.id || ""] || {}).setup || "");
      }
      case "/api/check": return check(body);
      case "/api/complete": {
        const ex = D.items[body.id] || {}; const sc = body.score;
        markDone(body.id, body.attempts || 1, !ex.warmup);
        logAttempt(body.id, { ok: !!sc && sc[0] >= 0.7 * sc[1], score: sc });
        return { ok: true };
      }
      case "/api/log": logAttempt(body.id, { ok: !!body.ok }); return { ok: true };
      case "/api/lesson-done": markLesson(body.id); return { ok: true };
      case "/api/review": recordReview(body.id, body.card, body.correct); return { ok: true };
      case "/api/draft": saveDraft(body.id, body.code || ""); return { ok: true };
    }
    return { error: "Not found" };
  }
  return { call };
})();
