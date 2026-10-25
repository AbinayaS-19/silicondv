/* SiliconDV Practice Lab.
   Hash router, two modes. Demo mode (API_BASE "") keeps accounts and
   progress in localStorage. Production mode talks to the backend API
   and keeps only the session token in localStorage. */

(function () {
  'use strict';

  var API_BASE = (window.PLAB_CONFIG && window.PLAB_CONFIG.API_BASE) || '';
  var DEMO = API_BASE === '';

  var DATA = null;      // contents of data/problems.json
  var session = null;   // {name, email} when signed in
  var progress = {};    // problem_id -> {status, updated_at}

  var LEVELS = ['beginner', 'intermediate', 'advanced'];
  var LEVEL_NAMES = { beginner: 'Beginner', intermediate: 'Intermediate', advanced: 'Advanced' };
  var DIFF_NAMES = { beginner: 'Easy', intermediate: 'Medium', advanced: 'Hard' };

  // Problem list filter state (module level so it survives re-renders).
  var filterTrack = 'all';
  var filterDiff = 'all';
  var filterSearch = '';

  /* ---------- small helpers ---------- */

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function $(sel) { return document.querySelector(sel); }

  function storeRead(key, fallback) {
    try {
      var v = localStorage.getItem(key);
      return v ? JSON.parse(v) : fallback;
    } catch (e) {
      return fallback;
    }
  }

  function storeWrite(key, val) {
    localStorage.setItem(key, JSON.stringify(val));
  }

  /* ---------- backend API (production mode) ---------- */

  async function api(path, opts) {
    opts = opts || {};
    var headers = { 'Content-Type': 'application/json' };
    var token = localStorage.getItem('plab_token');
    if (token) headers['Authorization'] = 'Bearer ' + token;
    var res = await fetch(API_BASE + path, {
      method: opts.method || 'GET',
      headers: headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined
    });
    var data = null;
    try { data = await res.json(); } catch (e) { /* empty or non JSON body */ }
    if (!res.ok) {
      var err = new Error((data && data.detail) || ('Request failed with status ' + res.status));
      err.status = res.status;
      throw err;
    }
    return data;
  }

  /* ---------- session and progress ---------- */

  function loadSession() {
    if (DEMO) {
      var email = storeRead('plab_demo_session', null);
      var users = storeRead('plab_demo_users', {});
      if (email && users[email]) {
        session = { name: users[email].name, email: email };
        progress = storeRead('plab_demo_progress', {})[email] || {};
      }
    } else {
      var user = storeRead('plab_user', null);
      if (localStorage.getItem('plab_token') && user) session = user;
    }
  }

  function saveProgressLocal() {
    if (DEMO && session) {
      var all = storeRead('plab_demo_progress', {});
      all[session.email] = progress;
      storeWrite('plab_demo_progress', all);
    }
  }

  function logout() {
    session = null;
    progress = {};
    if (DEMO) {
      localStorage.removeItem('plab_demo_session');
    } else {
      localStorage.removeItem('plab_token');
      localStorage.removeItem('plab_user');
    }
    location.hash = '#/';
  }

  async function recordProgress(problemId, status) {
    progress[problemId] = { status: status, updated_at: new Date().toISOString() };
    if (DEMO) {
      saveProgressLocal();
      return;
    }
    try {
      await api('/api/progress', {
        method: 'POST',
        body: { problem_id: problemId, status: status }
      });
    } catch (e) {
      // Keep the local copy so the page still works offline-ish.
      // The next successful call will carry the latest state.
    }
  }

  function statusOf(id) {
    return progress[id] ? progress[id].status : 'not-started';
  }

  function trackById(id) {
    for (var i = 0; i < DATA.tracks.length; i++) {
      if (DATA.tracks[i].id === id) return DATA.tracks[i];
    }
    return null;
  }

  function problemsFor(trackId) {
    return DATA.problems.filter(function (p) { return p.track === trackId; });
  }

  function problemById(id) {
    for (var i = 0; i < DATA.problems.length; i++) {
      if (DATA.problems[i].id === id) return DATA.problems[i];
    }
    return null;
  }

  function trackTitle(id) {
    var t = trackById(id);
    return t ? t.title : id;
  }

  function trackShort(id) {
    if (id === 'sva') return 'SVA';
    if (id === 'sv') return 'SystemVerilog';
    if (id === 'uvm') return 'UVM';
    return id;
  }

  function numKey(num) {
    var parts = String(num).split('.');
    return (parseInt(parts[0], 10) || 0) * 1000 + (parseInt(parts[1], 10) || 0);
  }

  function sortedProblems() {
    var order = {};
    DATA.tracks.forEach(function (t, i) { order[t.id] = i; });
    return DATA.problems.slice().sort(function (a, b) {
      var d = (order[a.track] || 0) - (order[b.track] || 0);
      if (d) return d;
      return numKey(a.num) - numKey(b.num);
    });
  }

  /* ---------- shared fragments ---------- */

  function diffLabel(level) {
    return '<span class="diff diff-' + level + '">' + DIFF_NAMES[level] + '</span>';
  }

  function statusCell(st) {
    if (st === 'completed') return '<span class="st st-done" title="Solved">&#10003;</span>';
    if (st === 'attempted') return '<span class="st st-tried" title="Attempted">&bull;</span>';
    return '<span class="st st-none" title="Not started">-</span>';
  }

  function statusLine(st) {
    if (st === 'completed') return '<span class="pstatus ps-done">&#10003; Solved</span>';
    if (st === 'attempted') return '<span class="pstatus ps-tried">&bull; Attempted</span>';
    return '<span class="pstatus ps-none">Not started</span>';
  }

  function notFoundHtml() {
    return '' +
      '<div class="notfound">' +
      '<h1>That page does not exist.</h1>' +
      '<p>The link might be old, or I might have moved things around. Either way, the lab is still here.</p>' +
      '<p><a class="btn" href="#/">Back home</a></p>' +
      '</div>';
  }

  function renderNav(active) {
    var nav = $('#nav');
    function link(href, name, label) {
      return '<a href="' + href + '"' + (name === active ? ' class="active"' : '') + '>' + label + '</a>';
    }
    var html = link('#/problems', 'problems', 'Problems') +
      link('#/dashboard', 'dashboard', 'Dashboard') +
      link('#/materials', 'materials', 'Materials');
    if (session) {
      html += '<span class="who">Hi, ' + esc(session.name) + '</span>' +
        '<button class="linklike" id="logout-btn" type="button">Log out</button>';
    } else {
      html += '<a href="#/login">Log in</a><a href="#/signup">Sign up</a>';
    }
    nav.innerHTML = html;
    var btn = $('#logout-btn');
    if (btn) btn.addEventListener('click', logout);
  }

  /* ---------- pages ---------- */

  // Richer track card content for the landing page. Honest, no invented stats.
  var TRACK_DETAIL = {
    sva: {
      covers: 'Implication operators, sequences, and the assertions that guard handshakes, FIFOs, and AXI style protocols.',
      whofor: 'For you if your assertions still feel like guesswork.'
    },
    sv: {
      covers: 'The RTL you will actually write: combinational logic, FSMs, FIFOs, CDC structures, and arbiters.',
      whofor: 'For you if you want your SystemVerilog to read like it came from someone who has taped out.'
    },
    uvm: {
      covers: 'How verification environments fit together: transactions, agents, scoreboards, sequences, and register models.',
      whofor: 'For you if a UVM interview or a new testbench has you building the plane while flying it.'
    }
  };

  function pageLanding() {
    var cards = DATA.tracks.map(function (t) {
      var n = problemsFor(t.id).length;
      var d = TRACK_DETAIL[t.id] || {};
      return '' +
        '<div class="card">' +
        '<h3><a href="#/track/' + t.id + '">' + esc(t.title) + '</a></h3>' +
        '<p>' + esc(t.blurb) + '</p>' +
        (d.covers ? '<p class="covers">' + esc(d.covers) + '</p>' : '') +
        (d.whofor ? '<p class="whofor">' + esc(d.whofor) + '</p>' : '') +
        '<div class="meta">' + n + ' problems</div>' +
        '<div class="go"><a href="#/track/' + t.id + '">Start this track</a></div>' +
        '</div>';
    }).join('');

    return '' +
      '<div class="hero">' +
      '<div class="kicker">SiliconDV Coding</div>' +
      '<h1>Practice hardware verification, one problem at a time.</h1>' +
      '<p class="lede">Practice problems for working verification engineers, from the SiliconDV community.</p>' +
      '<p class="lede">' + DATA.problems.length + ' short problems across SVA, SystemVerilog RTL, and UVM. ' +
      'Each one has a clear statement, a starter template, and a verified solution you can check yourself against.</p>' +
      '<div class="btn-row">' +
      '<a class="btn" href="#/signup">Let\'s get started</a>' +
      '<a class="btn btn-ghost" href="#/materials">Browse the materials</a>' +
      '</div>' +
      '</div>' +
      '<div class="why">' +
      '<p><strong>Why I built this.</strong></p>' +
      '<p>When I was learning verification, most resources either explained concepts with no practice, ' +
      'or threw full testbenches at me with no ramp. I wanted something in between: small problems with a ' +
      'clear statement, a starting template, and a solution I could check my work against. So I built it on ' +
      'weekends, the way I wish someone had built it for me.</p>' +
      '<p class="sig">Abi, design verification engineer and founder of SiliconDV</p>' +
      '</div>' +
      '<h2>The three tracks</h2>' +
      '<div class="cards">' + cards + '</div>' +
      '<h2>How it works</h2>' +
      '<div class="steps">' +
      '<div class="step"><div class="n">1</div><h3>Sign up</h3>' +
      '<p>Name and email, that is it. Your email only counts you as a real user and lets you pick up where you left off. ' +
      'Every problem is ranked Easy, Medium, or Hard, and each track runs beginner to advanced.</p></div>' +
      '<div class="step"><div class="n">2</div><h3>Practice</h3>' +
      '<p>Pick a track, read the statement, and work the problem in the editor. Stuck? Take the hints one at a time. ' +
      'Then check yourself against the verified solution and a three-question concept check.</p></div>' +
      '<div class="step"><div class="n">3</div><h3>Download</h3>' +
      '<p>Nine cheat sheets and guides, free to keep. One per track and level, from SVA basics to UVM expert topics, ' +
      'with interview notes on what hiring managers actually probe.</p></div>' +
      '</div>';
  }

  function pageSignup() {
    if (session) { location.hash = '#/dashboard'; return ''; }
    return '' +
      '<h1>Sign up</h1>' +
      '<p class="lede">Create your lab account. It takes ten seconds.</p>' +
      '<div class="form-card">' +
      '<div class="form-error" id="form-error"></div>' +
      '<form id="signup-form" novalidate>' +
      '<div class="field"><label for="f-name">Name</label>' +
      '<input id="f-name" name="name" type="text" autocomplete="name" required></div>' +
      '<div class="field"><label for="f-email">Email</label>' +
      '<input id="f-email" name="email" type="email" autocomplete="email" required></div>' +
      '<button class="btn" type="submit">Create account</button>' +
      '</form>' +
      '<p class="form-note">Your email is only used to count real users and to let you pick up where you left off. No spam, no sharing.</p>' +
      '<p class="form-note">Already have an account? <a href="#/login">Log in</a>.</p>' +
      '</div>';
  }

  function pageLogin() {
    if (session) { location.hash = '#/dashboard'; return ''; }
    return '' +
      '<h1>Log in</h1>' +
      '<p class="lede">Just your email. No password to forget.</p>' +
      '<div class="form-card">' +
      '<div class="form-error" id="form-error"></div>' +
      '<form id="login-form" novalidate>' +
      '<div class="field"><label for="f-email">Email</label>' +
      '<input id="f-email" name="email" type="email" autocomplete="email" required></div>' +
      '<button class="btn" type="submit">Log in</button>' +
      '</form>' +
      '<p class="form-note">New here? <a href="#/signup">Create an account</a>.</p>' +
      '</div>';
  }

  /* ----- problem list (#/problems and #/track/<id>) ----- */

  function solveTotals() {
    var done = DATA.problems.filter(function (p) { return statusOf(p.id) === 'completed'; }).length;
    var total = DATA.problems.length;
    var pct = total ? Math.round(done / total * 100) : 0;
    return { done: done, total: total, pct: pct };
  }

  function filteredProblems() {
    var q = filterSearch.trim().toLowerCase();
    return sortedProblems().filter(function (p) {
      if (filterTrack !== 'all' && p.track !== filterTrack) return false;
      if (filterDiff !== 'all' && p.level !== filterDiff) return false;
      if (q && p.title.toLowerCase().indexOf(q) === -1) return false;
      return true;
    });
  }

  function problemRowsHtml() {
    var rows = filteredProblems().map(function (p) {
      return '' +
        '<tr>' +
        '<td class="c-num mono">' + esc(p.num) + '</td>' +
        '<td class="c-title"><a href="#/problem/' + p.id + '">' + esc(p.title) + '</a>' +
        '<span class="c-track">' + esc(trackShort(p.track)) + '</span></td>' +
        '<td class="c-diff">' + diffLabel(p.level) + '</td>' +
        '<td class="c-status">' + statusCell(statusOf(p.id)) + '</td>' +
        '</tr>';
    }).join('');
    return rows;
  }

  function updateProblemRows() {
    var tbody = $('#problem-rows');
    if (tbody) tbody.innerHTML = problemRowsHtml();
    var count = $('#problem-count');
    if (count) {
      var n = filteredProblems().length;
      count.textContent = n === DATA.problems.length
        ? n + ' problems'
        : n + ' of ' + DATA.problems.length + ' problems';
    }
  }

  function chipRowHtml(label, group, options) {
    var chips = options.map(function (o) {
      var active = (group === 'track' ? filterTrack : filterDiff) === o.value;
      return '<button type="button" class="chip' + (active ? ' on' : '') + '"' +
        ' data-group="' + group + '" data-value="' + o.value + '">' + esc(o.label) + '</button>';
    }).join('');
    return '<span class="chip-label">' + label + '</span> ' + chips;
  }

  function pageProblems(presetTrack) {
    if (presetTrack) {
      var t = trackById(presetTrack);
      if (!t) return notFoundHtml();
      filterTrack = presetTrack;
      filterDiff = 'all';
      filterSearch = '';
    } else {
      // A fresh visit to #/problems always starts from the full list.
      filterTrack = 'all';
      filterDiff = 'all';
      filterSearch = '';
    }

    var totals = solveTotals();
    var title = presetTrack ? trackTitle(presetTrack) : 'Problems';
    var back = presetTrack
      ? '<p><a href="#/problems">&larr; All problems</a></p>'
      : '';

    return '' +
      back +
      '<h1>' + esc(title) + '</h1>' +
      '<p class="lede">Solved ' + totals.done + ' of ' + totals.total + ' (' + totals.pct + '%)</p>' +
      '<div class="filters">' +
      '<div class="chip-row">' + chipRowHtml('Track', 'track', [
        { value: 'all', label: 'All' },
        { value: 'sva', label: 'SVA' },
        { value: 'sv', label: 'SystemVerilog' },
        { value: 'uvm', label: 'UVM' }
      ]) + '</div>' +
      '<div class="chip-row">' + chipRowHtml('Difficulty', 'diff', [
        { value: 'all', label: 'All' },
        { value: 'beginner', label: 'Easy' },
        { value: 'intermediate', label: 'Medium' },
        { value: 'advanced', label: 'Hard' }
      ]) + '</div>' +
      '<div class="search-row"><input id="f-search" type="search" placeholder="Search by title" value="' +
      esc(filterSearch) + '" aria-label="Search problems by title"></div>' +
      '</div>' +
      '<p class="muted-line" id="problem-count"></p>' +
      '<table class="plist">' +
      '<thead><tr><th class="c-num">#</th><th>Title</th><th class="c-diff">Difficulty</th>' +
      '<th class="c-status">Status</th></tr></thead>' +
      '<tbody id="problem-rows">' + problemRowsHtml() + '</tbody>' +
      '</table>' +
      '<p class="legend muted-line"><span class="st st-done">&#10003;</span> solved &nbsp;&middot;&nbsp; ' +
      '<span class="st st-tried">&bull;</span> attempted &nbsp;&middot;&nbsp; ' +
      '<span class="st st-none">-</span> not started</p>';
  }

  function wireProblems() {
    var count = $('#problem-count');
    if (count) {
      var n = filteredProblems().length;
      count.textContent = n === DATA.problems.length
        ? n + ' problems'
        : n + ' of ' + DATA.problems.length + ' problems';
    }
    document.querySelectorAll('.chip').forEach(function (chip) {
      chip.addEventListener('click', function () {
        var group = chip.getAttribute('data-group');
        var value = chip.getAttribute('data-value');
        if (group === 'track') filterTrack = value;
        else filterDiff = value;
        document.querySelectorAll('.chip[data-group="' + group + '"]').forEach(function (c) {
          c.classList.toggle('on', c.getAttribute('data-value') === value);
        });
        updateProblemRows();
      });
    });
    var search = $('#f-search');
    if (search) {
      search.addEventListener('input', function () {
        filterSearch = search.value;
        updateProblemRows();
      });
    }
  }

  /* ----- problem page (#/problem/<id>) ----- */

  var KIND_LABELS = {
    code: 'Verified solution',
    approach: 'Reference approach',
    keypoints: 'Key points'
  };

  var solutionRevealed = false; // per page render

  function solutionHtml(p) {
    var label = KIND_LABELS[p.solution_kind] || 'Solution';
    if (!solutionRevealed && statusOf(p.id) !== 'completed') {
      return '' +
        '<div class="locked">' +
        '<p>Work through the problem first, then compare against the verified solution.</p>' +
        '<button class="btn" id="reveal-tab" type="button">Reveal solution</button>' +
        '</div>';
    }
    return '<div class="solution-label">' + esc(label) + '</div>' +
      '<pre class="code">' + esc(p.solution) + '</pre>' +
      (p.takeaway
        ? '<div class="takeaway"><strong>Takeaway.</strong> ' + esc(p.takeaway) + '</div>'
        : '');
  }

  function pageProblem(id) {
    var p = problemById(id);
    if (!p) return notFoundHtml();
    var st = statusOf(id);
    var t = trackById(p.track);
    solutionRevealed = (st === 'completed');

    var quiz = (p.quiz || []).map(function (q, qi) {
      var choices = q.choices.map(function (c, ci) {
        return '<button type="button" class="choice" data-q="' + qi + '" data-c="' + ci + '">' +
          '<span class="clett">' + 'ABCD'[ci] + '</span> ' + esc(c) + '</button>';
      }).join('');
      return '' +
        '<div class="quiz-q" data-q="' + qi + '">' +
        '<p class="qq"><span class="qnum">Q' + (qi + 1) + '.</span> ' + esc(q.q) + '</p>' +
        '<div class="choices">' + choices + '</div>' +
        '<p class="why" hidden></p>' +
        '</div>';
    }).join('');

    var notes = storeRead('plab_notes', {})[id] || '';
    var draft = storeRead('plab_drafts', {})[id];
    var editorText = (draft != null && draft !== '') ? draft : p.starter;

    return '' +
      '<p><a href="#/track/' + p.track + '">&larr; ' + esc(t ? t.title : p.track) + '</a></p>' +
      '<div class="prob-head">' +
      '<h1><span class="mono pnum">' + esc(p.num) + '</span> ' + esc(p.title) + '</h1>' +
      '<p>' + diffLabel(p.level) + ' ' + '<span id="p-status">' + statusLine(st) + '</span></p>' +
      '</div>' +
      '<div class="prob-grid">' +
      '<div class="pane pane-left">' +
      '<div class="tabs" role="tablist">' +
      '<button type="button" class="tab on" data-tab="desc">Description</button>' +
      '<button type="button" class="tab" data-tab="sol">Solution</button>' +
      '<button type="button" class="tab" data-tab="notes">Notes</button>' +
      '</div>' +
      '<div class="tabpane" id="tab-desc">' +
      '<p>' + esc(p.details || p.statement) + '</p>' +
      '<div class="code-label">Worked example</div>' +
      '<pre class="code">' + esc(p.example || '') + '</pre>' +
      '<div class="code-label">Constraints</div>' +
      '<ul class="constraints">' +
      (p.constraints || []).map(function (c) { return '<li>' + esc(c) + '</li>'; }).join('') +
      '</ul>' +
      '<div class="code-label">Hints</div>' +
      '<div id="hints">' +
      '<p class="tiny muted-line">Stuck? Take them one at a time. They nudge, they never give away the answer.</p>' +
      '<button class="btn btn-ghost" id="hint-btn" type="button">Need a hint?</button>' +
      '<ol id="hint-list" class="hint-list"></ol>' +
      '</div>' +
      '</div>' +
      '<div class="tabpane" id="tab-sol" hidden>' + solutionHtml(p) + '</div>' +
      '<div class="tabpane" id="tab-notes" hidden>' +
      '<div class="code-label">Your notes</div>' +
      '<textarea id="notes" rows="12" placeholder="What tripped you up? What will you remember next time?">' +
      esc(notes) + '</textarea>' +
      '<p class="tiny muted-line">Saved in this browser only.</p>' +
      '</div>' +
      '</div>' +
      '<div class="pane pane-right">' +
      '<div class="code-label">Your answer</div>' +
      '<div class="editor">' +
      '<div class="gutter" id="ed-gutter" aria-hidden="true"></div>' +
      '<textarea id="ed" spellcheck="false" aria-label="Code editor">' + esc(editorText) + '</textarea>' +
      '</div>' +
      '<p class="tiny muted-line">Drafts stay in this browser only. No simulator here yet. ' +
      'Check your work against the verified solution.</p>' +
      '<div class="btn-row">' +
      '<button class="btn btn-ghost" id="reveal-btn" type="button">Reveal solution</button>' +
      '<button class="btn" id="mark-complete" type="button">Mark as solved</button>' +
      '<span class="self-note">self-attested</span>' +
      '</div>' +
      '<h3 class="quiz-head">Concept check</h3>' +
      '<p class="tiny muted-line">Three questions on this problem. Answering does not affect your progress.</p>' +
      '<div id="quiz">' + quiz + '</div>' +
      '</div>' +
      '</div>';
  }

  function updateGutter() {
    var ed = $('#ed');
    var gutter = $('#ed-gutter');
    if (!ed || !gutter) return;
    var lines = ed.value.split('\n').length;
    var html = '';
    for (var i = 1; i <= lines; i++) html += i + '\n';
    gutter.textContent = html;
    gutter.scrollTop = ed.scrollTop;
  }

  function revealSolution(id) {
    solutionRevealed = true;
    var tab = $('#tab-sol');
    if (tab) tab.innerHTML = solutionHtml(problemById(id));
    // Switch the left pane to the Solution tab.
    document.querySelectorAll('.tab').forEach(function (b) {
      b.classList.toggle('on', b.getAttribute('data-tab') === 'sol');
    });
    ['desc', 'sol', 'notes'].forEach(function (name) {
      var pane = $('#tab-' + name);
      if (pane) pane.hidden = (name !== 'sol');
    });
    var statusEl = $('#p-status');
    if (statusEl) statusEl.innerHTML = statusLine(statusOf(id));
  }

  function wireProblem(id) {
    var p = problemById(id);
    if (!p) return;

    // Tabs.
    document.querySelectorAll('.tab').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var name = btn.getAttribute('data-tab');
        document.querySelectorAll('.tab').forEach(function (b) {
          b.classList.toggle('on', b === btn);
        });
        ['desc', 'sol', 'notes'].forEach(function (n) {
          var pane = $('#tab-' + n);
          if (pane) pane.hidden = (n !== name);
        });
      });
    });

    // Reveal from either the tab or the button under the editor.
    async function doReveal() {
      if (statusOf(id) === 'not-started') {
        await recordProgress(id, 'attempted');
      }
      revealSolution(id);
    }
    var revealTab = $('#reveal-tab');
    if (revealTab) revealTab.addEventListener('click', doReveal);
    var revealBtn = $('#reveal-btn');
    if (revealBtn) revealBtn.addEventListener('click', doReveal);

    var doneBtn = $('#mark-complete');
    if (doneBtn) {
      doneBtn.addEventListener('click', async function () {
        await recordProgress(id, 'completed');
        route(false);
      });
    }

    // Editor: gutter sync, Tab inserts two spaces, autosave draft.
    var ed = $('#ed');
    if (ed) {
      updateGutter();
      ed.addEventListener('input', function () {
        updateGutter();
        var drafts = storeRead('plab_drafts', {});
        drafts[id] = ed.value;
        storeWrite('plab_drafts', drafts);
      });
      ed.addEventListener('scroll', function () {
        var gutter = $('#ed-gutter');
        if (gutter) gutter.scrollTop = ed.scrollTop;
      });
      ed.addEventListener('keydown', function (e) {
        if (e.key === 'Tab') {
          e.preventDefault();
          var start = ed.selectionStart;
          var end = ed.selectionEnd;
          ed.value = ed.value.slice(0, start) + '  ' + ed.value.slice(end);
          ed.selectionStart = ed.selectionEnd = start + 2;
          ed.dispatchEvent(new Event('input'));
        }
      });
    }

    // Notes: saved per problem to localStorage.
    var notes = $('#notes');
    if (notes) {
      notes.addEventListener('input', function () {
        var all = storeRead('plab_notes', {});
        all[id] = notes.value;
        storeWrite('plab_notes', all);
      });
    }

    // Hints: progressive reveal, one at a time.
    var hintBtn = $('#hint-btn');
    var hintList = $('#hint-list');
    if (hintBtn && hintList) {
      var hints = p.hints || [];
      var shown = 0;
      if (!hints.length) { hintBtn.hidden = true; }
      hintBtn.addEventListener('click', function () {
        if (shown < hints.length) {
          var li = document.createElement('li');
          li.className = 'hint';
          li.textContent = hints[shown];
          hintList.appendChild(li);
          shown++;
          if (shown >= hints.length) {
            hintBtn.textContent = 'That is all of them';
            hintBtn.disabled = true;
          } else {
            hintBtn.textContent = 'Another hint?';
          }
        }
      });
    }

    // Quiz: auto-graded on selection with instant feedback.
    var quizData = p.quiz || [];
    document.querySelectorAll('#quiz .choice').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var qi = parseInt(btn.getAttribute('data-q'), 10);
        var ci = parseInt(btn.getAttribute('data-c'), 10);
        var q = quizData[qi];
        if (!q) return;
        var wrap = btn.closest('.quiz-q');
        if (wrap.getAttribute('data-answered') === '1') return;
        wrap.setAttribute('data-answered', '1');
        wrap.querySelectorAll('.choice').forEach(function (b) {
          var bi = parseInt(b.getAttribute('data-c'), 10);
          b.disabled = true;
          if (bi === q.answer) b.classList.add('right');
          else if (bi === ci) b.classList.add('wrong');
        });
        var why = wrap.querySelector('.why');
        if (why) {
          why.hidden = false;
          why.innerHTML = (ci === q.answer ? '<strong>Correct.</strong> ' : '<strong>Not quite.</strong> ') +
            esc(q.why);
        }
      });
    });
  }

  /* ----- dashboard (#/dashboard) ----- */

  function pageDashboard() {
    var totals = solveTotals();
    var html = '<h1>Your progress</h1>';

    if (session) {
      html += '<p class="lede">Hi, ' + esc(session.name) + '. Solved ' + totals.done +
        ' of ' + totals.total + '.</p>';
    }

    if (totals.done === 0) {
      html += '<div class="empty">Nothing completed yet. Pick a track below and start with the easy problems.</div>';
    }

    // Difficulty breakdown.
    var diffCells = LEVELS.map(function (lv) {
      var inLevel = DATA.problems.filter(function (p) { return p.level === lv; });
      var doneLevel = inLevel.filter(function (p) { return statusOf(p.id) === 'completed'; }).length;
      var pct = inLevel.length ? Math.round(doneLevel / inLevel.length * 100) : 0;
      return '' +
        '<div class="diff-cell">' +
        '<div class="diff-top">' + diffLabel(lv) +
        '<span class="count">' + doneLevel + '/' + inLevel.length + '</span></div>' +
        '<div class="bar"><span style="width:' + pct + '%"></span></div>' +
        '</div>';
    }).join('');
    html += '<h2>By difficulty</h2><div class="diff-grid">' + diffCells + '</div>';

    // Per track progress bars.
    html += '<h2>By track</h2>';
    DATA.tracks.forEach(function (t) {
      var ps = problemsFor(t.id);
      var done = ps.filter(function (p) { return statusOf(p.id) === 'completed'; }).length;
      var pct = ps.length ? Math.round(done / ps.length * 100) : 0;
      var breakdown = LEVELS.map(function (lv) {
        var inLevel = ps.filter(function (p) { return p.level === lv; });
        var doneLevel = inLevel.filter(function (p) { return statusOf(p.id) === 'completed'; }).length;
        return DIFF_NAMES[lv] + ' ' + doneLevel + '/' + inLevel.length;
      }).join(' &middot; ');
      html += '' +
        '<div class="track-progress">' +
        '<div class="top"><h3><a href="#/track/' + t.id + '">' + esc(t.title) + '</a></h3>' +
        '<span class="count">' + done + ' of ' + ps.length + ' complete</span></div>' +
        '<div class="bar"><span style="width:' + pct + '%"></span></div>' +
        '<div class="levels">' + breakdown + '</div>' +
        '</div>';
    });

    // Recent activity (filled in by wireDashboard).
    html += '<h2>Recent activity</h2><div id="activity"><p class="muted-line">Loading...</p></div>';
    return html;
  }

  function timeAgo(ts) {
    var t = new Date(ts).getTime();
    if (isNaN(t)) return '';
    var mins = Math.floor((Date.now() - t) / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return mins + 'm ago';
    var hours = Math.floor(mins / 60);
    if (hours < 24) return hours + 'h ago';
    var days = Math.floor(hours / 24);
    if (days < 30) return days + 'd ago';
    return new Date(t).toLocaleDateString();
  }

  function activityHtml(events) {
    if (!events.length) {
      return '<p class="muted-line">No activity yet. Open a problem and mark it solved or attempted.</p>';
    }
    return '<ul class="activity">' + events.slice(0, 8).map(function (ev) {
      var p = problemById(ev.problem_id);
      var title = p ? p.title : ev.problem_id;
      var num = p ? p.num : '';
      var what = ev.status === 'completed' ? 'Solved' : 'Attempted';
      var cls = ev.status === 'completed' ? 'st-done' : 'st-tried';
      return '<li><span class="st ' + cls + '">' + (ev.status === 'completed' ? '&#10003;' : '&bull;') +
        '</span> <a href="#/problem/' + esc(ev.problem_id) + '">' +
        (num ? '<span class="mono muted-line">' + esc(num) + '</span> ' : '') + esc(title) + '</a>' +
        '<span class="muted-line"> ' + what.toLowerCase() + ' ' + esc(timeAgo(ev.updated_at)) + '</span></li>';
    }).join('') + '</ul>';
  }

  async function wireDashboard() {
    var box = $('#activity');
    if (!box) return;
    if (DEMO) {
      var events = Object.keys(progress).map(function (id) {
        return { problem_id: id, status: progress[id].status, updated_at: progress[id].updated_at };
      }).filter(function (ev) { return ev.updated_at; })
        .sort(function (a, b) { return new Date(b.updated_at) - new Date(a.updated_at); });
      box.innerHTML = activityHtml(events);
      return;
    }
    try {
      var data = await api('/api/activity');
      var events2 = Array.isArray(data) ? data : (data && data.events) || [];
      box.innerHTML = activityHtml(events2);
    } catch (e) {
      // Graceful: the dashboard still works without the activity feed.
      box.innerHTML = '<p class="muted-line">Activity is unavailable right now.</p>';
    }
  }

  /* ----- materials (unchanged) ----- */

  function pageMaterials() {
    var html = '<h1>Materials</h1>' +
      '<p class="lede">Nine cheat sheets and guides, free to keep. One per track and level.</p>' +
      '<div class="mat-grid">';
    DATA.materials.forEach(function (m) {
      var dl;
      if (DEMO) {
        dl = '<a class="btn btn-ghost" href="https://github.com/AbinayaS-19/silicondv/releases/download/practice-materials-v1/' + esc(m.file.replace(/\.md$/, '.pdf')) + '">Download PDF</a>';
      } else {
        dl = '<button class="btn btn-ghost" type="button" data-dl="' + esc(m.id) + '" data-file="' + esc(m.file) + '">Download</button>';
      }
      html += '' +
        '<div class="card">' +
        '<h3>' + esc(m.title) + '</h3>' +
        '<p>' + esc(m.blurb) + '</p>' +
        '<div class="meta">' + esc(trackTitle(m.track)) + ' &middot; ' + LEVEL_NAMES[m.level] + '</div>' +
        '<div class="go">' + dl + '</div>' +
        '</div>';
    });
    html += '</div>';
    html += '<p class="mat-note" id="dl-error" hidden></p>';
    return html;
  }

  /* ---------- event wiring ---------- */

  function showFormError(msg) {
    var el = $('#form-error');
    if (!el) return;
    el.textContent = msg;
    el.classList.add('show');
  }

  function validEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  }

  function wireSignup() {
    var form = $('#signup-form');
    if (!form) return;
    form.addEventListener('submit', async function (e) {
      e.preventDefault();
      var name = $('#f-name').value.trim();
      var email = $('#f-email').value.trim().toLowerCase();
      if (!name) { showFormError('Please enter your name.'); return; }
      if (!validEmail(email)) { showFormError('That email does not look right. Check it and try again.'); return; }

      if (DEMO) {
        var users = storeRead('plab_demo_users', {});
        if (users[email]) {
          showFormError('This email is already signed up. Try logging in instead.');
          return;
        }
        users[email] = { name: name, email: email };
        storeWrite('plab_demo_users', users);
        storeWrite('plab_demo_session', email);
        session = { name: name, email: email };
        progress = {};
        location.hash = '#/problems';
        return;
      }

      try {
        var res = await api('/api/signup', { method: 'POST', body: { name: name, email: email } });
        localStorage.setItem('plab_token', res.token);
        session = { name: res.user.name, email: res.user.email };
        storeWrite('plab_user', session);
        progress = {};
        location.hash = '#/problems';
      } catch (err) {
        showFormError(err.message);
      }
    });
  }

  function wireLogin() {
    var form = $('#login-form');
    if (!form) return;
    form.addEventListener('submit', async function (e) {
      e.preventDefault();
      var email = $('#f-email').value.trim().toLowerCase();
      if (!validEmail(email)) { showFormError('That email does not look right. Check it and try again.'); return; }

      if (DEMO) {
        var users = storeRead('plab_demo_users', {});
        if (!users[email]) {
          showFormError('No account found for this email. Sign up first.');
          return;
        }
        storeWrite('plab_demo_session', email);
        session = { name: users[email].name, email: email };
        progress = storeRead('plab_demo_progress', {})[email] || {};
        location.hash = '#/dashboard';
        return;
      }

      try {
        var res = await api('/api/login', { method: 'POST', body: { email: email } });
        localStorage.setItem('plab_token', res.token);
        session = { name: res.user.name, email: res.user.email };
        storeWrite('plab_user', session);
        try {
          var me = await api('/api/me');
          progress = me.progress || {};
        } catch (e2) { progress = {}; }
        location.hash = '#/dashboard';
      } catch (err) {
        showFormError(err.message);
      }
    });
  }

  async function downloadMaterial(id, file) {
    var errEl = $('#dl-error');
    try {
      var token = localStorage.getItem('plab_token');
      var res = await fetch(API_BASE + '/api/materials/' + encodeURIComponent(id) + '/download', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + token }
      });
      if (!res.ok) throw new Error('download failed with status ' + res.status);
      var blob = await res.blob();
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = file;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
    } catch (e) {
      if (errEl) {
        errEl.textContent = 'The download did not work. Check your connection and try again.';
        errEl.hidden = false;
      }
    }
  }

  function wireMaterials() {
    var btns = document.querySelectorAll('[data-dl]');
    btns.forEach(function (btn) {
      btn.addEventListener('click', function () {
        downloadMaterial(btn.getAttribute('data-dl'), btn.getAttribute('data-file'));
      });
    });
  }

  /* ---------- router ---------- */

  var GATED = { dashboard: 1, problems: 1, track: 1, problem: 1, materials: 1 };

  function route(scrollTop) {
    var hash = location.hash || '#/';
    var parts = hash.replace(/^#\/?/, '').split('/');
    var name = parts[0] || '';
    var arg = parts[1];
    var app = $('#app');

    if (GATED[name] && !session) {
      location.hash = '#/signup';
      return;
    }

    var html;
    if (name === '') html = pageLanding();
    else if (name === 'signup') html = pageSignup();
    else if (name === 'login') html = pageLogin();
    else if (name === 'dashboard') html = pageDashboard();
    else if (name === 'problems') html = pageProblems(null);
    else if (name === 'track') html = pageTrackRedirect(arg);
    else if (name === 'problem') html = pageProblem(arg);
    else if (name === 'materials') html = pageMaterials();
    else html = notFoundHtml();

    // pageSignup/pageLogin redirect when already signed in; nothing to paint.
    if (html === '') return;

    app.innerHTML = html;
    if (scrollTop !== false) window.scrollTo(0, 0);

    if (name === 'signup') wireSignup();
    if (name === 'login') wireLogin();
    if (name === 'dashboard') wireDashboard();
    if (name === 'problems' || name === 'track') wireProblems();
    if (name === 'problem') wireProblem(arg);
    if (name === 'materials') wireMaterials();
    renderNav(name === 'track' ? 'problems' : name);
  }

  // #/track/<id> keeps working: it renders the same problem table,
  // pre-filtered to that track (landing page track cards link here).
  function pageTrackRedirect(trackId) {
    return pageProblems(trackId);
  }

  /* ---------- boot ---------- */

  async function boot() {
    
    loadSession();

    try {
      var res = await fetch('data/problems.json');
      if (!res.ok) throw new Error('HTTP ' + res.status);
      DATA = await res.json();
    } catch (e) {
      $('#app').innerHTML =
        '<div class="notfound"><h1>The lab data did not load.</h1>' +
        '<p>data/problems.json could not be read. If you are opening index.html straight from disk, ' +
        'serve this folder over HTTP instead (for example, python3 -m http.server).</p></div>';
      return;
    }

    if (!DEMO && localStorage.getItem('plab_token')) {
      try {
        var me = await api('/api/me');
        session = { name: me.user.name, email: me.user.email };
        storeWrite('plab_user', session);
        progress = me.progress || {};
      } catch (e) {
        // Token is stale or the backend is unreachable. Drop the session
        // rather than showing a logged-in shell that does not work.
        localStorage.removeItem('plab_token');
        localStorage.removeItem('plab_user');
        session = null;
        progress = {};
      }
    }

    renderNav('');
    window.addEventListener('hashchange', function () { route(); });
    route();
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
