(() => {
  const PROGRESS_KEY = "nihongoshiken_progress_v2";

  let catalog = null;
  let activeMeta = null;
  let activeExam = null;
  let currentIndex = 0;
  let answers = {};

  const $ = (id) => document.getElementById(id);

  function escapeHtml(text) {
    return String(text)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function formatPassage(context) {
    if (!context) return "";

    const text = String(context).replace(/\r\n/g, "\n").trim();
    const footnoteStart = text.search(/\n（注[０-９\d]/);
    const body =
      footnoteStart >= 0 ? text.slice(0, footnoteStart).trim() : text;
    const footnotes =
      footnoteStart >= 0 ? text.slice(footnoteStart).trim() : "";

    const bodyHtml = body
      .split(/\n+/)
      .filter(Boolean)
      .map((p) => `<p class="passage-p">${escapeHtml(p)}</p>`)
      .join("");

    let footnotesHtml = "";
    if (footnotes) {
      const items = footnotes.split(/\n+/).filter(Boolean);
      footnotesHtml = `
        <div class="passage-footnotes">
          <div class="passage-footnotes-label">Chú thích</div>
          ${items
            .map((item) => `<div class="passage-footnote">${escapeHtml(item)}</div>`)
            .join("")}
        </div>`;
    }

    return `<div class="passage-body">${bodyHtml}</div>${footnotesHtml}`;
  }

  function buildSpeakText(q, selectedChoice) {
    const buildSortedSentenceFromExplanation = () => {
      const question = String(q.question || "");
      const explanation = String(q.explanation || "");
      if (!/__★__|[_＿]{2,}/.test(question)) return "";

      const m = explanation.match(/Thứ tự đúng:\s*([^\n\r]+)/i);
      if (!m) return "";
      const orderText = m[1];
      const ordered = orderText
        .split(/→|->|=>/g)
        .map((s) => s.replace(/（★）|\(★\)|★/g, "").trim())
        .filter(Boolean);
      if (ordered.length < 2) return "";

      const clusterRegex = /\s*(?:__★__|[_＿]{2,})(?:\s+(?:__★__|[_＿]{2,}))*\s*/;
      if (!clusterRegex.test(question)) return "";
      return question.replace(clusterRegex, ` ${ordered.join(" ")} `);
    };

    const sanitizeForSpeech = (text) =>
      String(text || "")
        .replace(/<[^>]+>/g, " ")
        // Convert sorting blanks to natural pause.
        .replace(/(__★__|★|[_＿]{2,})(\s*(__★__|★|[_＿]{2,}))*/g, " … ")
        // Remove parenthetical numeric markers like （１２・２０２２）, （21）, （2020年）.
        .replace(/（[\d０-９\s・.．,，/／\-ー〜～年月日]+）/g, "")
        // Remove extra spaces created by cleanup.
        .replace(/[ \t]+/g, " ")
        .replace(/\s*…\s*/g, " … ")
        .replace(/\n{3,}/g, "\n\n")
        .trim();

    const fillSingleBlank = (question, fillText) => {
      const source = String(question || "");
      const fill = String(fillText || "").trim();
      if (!fill) return source;
      // Replace one simple blank like (   ) / （   ） with selected option.
      const replaced = source.replace(/[（(]\s*[)\uFF09]/, `（${fill}）`);
      if (replaced !== source) return replaced;
      return source.replace(/[（(]\s*[_＿・\.\s]{1,20}\s*[)\uFF09]/, `（${fill}）`);
    };

    const extractQuestionPrompt = (question) => {
      const cleaned = sanitizeForSpeech(question);
      if (!cleaned) return "";
      const lines = cleaned.split("\n").map((s) => s.trim()).filter(Boolean);
      const jpLine = lines.find((line) => /[\u3040-\u30ff\u3400-\u9fff]/.test(line));
      return jpLine || lines[0] || "";
    };

    // Read the question itself only (stable and short).
    const sortedFullSentence = buildSortedSentenceFromExplanation();
    if (sortedFullSentence) return extractQuestionPrompt(sortedFullSentence);

    const maybeFilled =
      selectedChoice !== undefined &&
      q.options &&
      Number(selectedChoice) >= 1 &&
      Number(selectedChoice) <= q.options.length
        ? fillSingleBlank(q.question || "", q.options[Number(selectedChoice) - 1])
        : q.question || "";
    return extractQuestionPrompt(maybeFilled);
  }

  function isListeningQuestion(q) {
    return Boolean(
      q &&
        (q.type === "listening" ||
          (Array.isArray(q.dialogue) && q.dialogue.length) ||
          (q.transcript && String(q.transcript).trim()) ||
          (activeMeta && activeMeta.topic === "listening"))
    );
  }

  function hasOfficialKey(q) {
    const n = Number(q && q.correct_answer);
    return Number.isInteger(n) && n >= 1;
  }

  function stopSpeech() {
    listeningSpeakToken += 1;
    if ("speechSynthesis" in window) window.speechSynthesis.cancel();
  }

  let listeningSpeakToken = 0;

  function listJaVoices() {
    if (!("speechSynthesis" in window)) return [];
    return window.speechSynthesis
      .getVoices()
      .filter((v) => v.lang && v.lang.toLowerCase().startsWith("ja"));
  }

  function pickJaVoice() {
    return listJaVoices()[0] || null;
  }

  function scoreVoiceName(name, kind) {
    const n = String(name || "").toLowerCase();
    const maleHints = ["ichiro", "keita", "male", "男", "otoko"];
    const femaleHints = ["haruka", "ayumi", "nanami", "female", "女", "onna"];
    const hints = kind === "male" ? maleHints : femaleHints;
    return hints.some((h) => n.includes(h)) ? 2 : 0;
  }

  function pickDialogueVoices() {
    const ja = listJaVoices();
    if (!ja.length) return { male: null, female: null, narrator: null };

    const rankedMale = [...ja].sort(
      (a, b) => scoreVoiceName(b.name, "male") - scoreVoiceName(a.name, "male")
    );
    const rankedFemale = [...ja].sort(
      (a, b) => scoreVoiceName(b.name, "female") - scoreVoiceName(a.name, "female")
    );

    let male = rankedMale[0];
    let female = rankedFemale[0];

    if (male && female && male.voiceURI === female.voiceURI && ja.length > 1) {
      female = ja.find((v) => v.voiceURI !== male.voiceURI) || female;
    }

    // Prefer distinct voices when name heuristics failed but 2+ ja voices exist.
    if (
      ja.length > 1 &&
      male &&
      female &&
      male.voiceURI === female.voiceURI
    ) {
      male = ja[0];
      female = ja[1];
    }

    return { male, female, narrator: female || male || ja[0] };
  }

  function parseDialogueTurns(q) {
    if (Array.isArray(q.dialogue) && q.dialogue.length) {
      return q.dialogue
        .map((row) => ({
          role: row.role || "narrator",
          text: String(row.jp || row.text || "").trim(),
          vi: String(row.vi || "").trim(),
        }))
        .filter((t) => t.text);
    }

    const raw = String(q.transcript || q.tts_script || "")
      .replace(/\r\n/g, "\n")
      .trim();
    if (!raw) return [];

    const turns = [];
    for (const line of raw.split(/\n+/).map((s) => s.trim()).filter(Boolean)) {
      const m = line.match(/^(男の人|女の人|男|女)\s*[：:]\s*(.+)$/);
      if (m) {
        const who = m[1];
        const role = who.startsWith("男") ? "male" : "female";
        turns.push({ role, text: m[2].trim(), vi: "" });
      } else {
        turns.push({ role: "narrator", text: line, vi: "" });
      }
    }
    return turns.filter((t) => t.text);
  }

  function buildListeningSpeakText(q) {
    const turns = parseDialogueTurns(q);
    if (turns.length) return turns.map((t) => t.text).join("\n");
    const raw = String(q.tts_script || q.transcript || "").trim();
    if (!raw) return "";
    return raw
      .replace(/^(男|女|男の人|女の人)\s*[：:]/gm, "")
      .replace(/[ \t]+/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function speakJapanese(text, { buttonId, idleLabel, speakingLabel } = {}) {
    const btn = buttonId ? $(buttonId) : null;
    if (!("speechSynthesis" in window)) {
      if (btn) btn.textContent = "Không hỗ trợ";
      return;
    }
    if (window.speechSynthesis.speaking) {
      stopSpeech();
      if (btn && idleLabel) btn.textContent = idleLabel;
      return;
    }
    if (!text) return;

    const utter = new SpeechSynthesisUtterance(text);
    utter.lang = "ja-JP";
    utter.rate = 0.92;
    utter.pitch = 1;
    const jaVoice = pickJaVoice();
    if (jaVoice) utter.voice = jaVoice;

    if (btn && speakingLabel) btn.textContent = speakingLabel;
    utter.onend = () => {
      const current = buttonId ? $(buttonId) : null;
      if (current && idleLabel) current.textContent = idleLabel;
    };
    utter.onerror = () => {
      const current = buttonId ? $(buttonId) : null;
      if (current) current.textContent = "Đọc lỗi";
    };
    window.speechSynthesis.speak(utter);
  }

  function speakDialogueTurns(turns, { buttonId, idleLabel, speakingLabel } = {}) {
    const btn = buttonId ? $(buttonId) : null;
    if (!("speechSynthesis" in window)) {
      if (btn) btn.textContent = "Không hỗ trợ";
      return;
    }
    if (window.speechSynthesis.speaking) {
      stopSpeech();
      if (btn && idleLabel) btn.textContent = idleLabel;
      return;
    }
    if (!turns.length) return;

    const token = ++listeningSpeakToken;
    const voices = pickDialogueVoices();
    const sameVoice =
      !voices.male ||
      !voices.female ||
      voices.male.voiceURI === voices.female.voiceURI;

    if (btn && speakingLabel) btn.textContent = speakingLabel;

    const finish = (ok) => {
      if (token !== listeningSpeakToken) return;
      const current = buttonId ? $(buttonId) : null;
      if (!current || !idleLabel) return;
      current.textContent = ok ? idleLabel : "Đọc lỗi";
    };

    let i = 0;
    const speakNext = () => {
      if (token !== listeningSpeakToken) return;
      if (i >= turns.length) {
        finish(true);
        return;
      }
      const turn = turns[i++];
      const utter = new SpeechSynthesisUtterance(turn.text);
      utter.lang = "ja-JP";
      utter.rate = 0.92;

      if (turn.role === "male") {
        if (voices.male) utter.voice = voices.male;
        utter.pitch = sameVoice ? 0.75 : 1;
      } else if (turn.role === "female") {
        if (voices.female) utter.voice = voices.female;
        utter.pitch = sameVoice ? 1.25 : 1.05;
      } else {
        if (voices.narrator) utter.voice = voices.narrator;
        utter.pitch = 1;
        utter.rate = 0.88;
      }

      utter.onend = speakNext;
      utter.onerror = () => finish(false);
      window.speechSynthesis.speak(utter);
    };

    speakNext();
  }

  function speakListeningAudio() {
    if (!activeExam) return;
    const q = activeExam.questions[currentIndex];
    if (!q) return;
    const turns = parseDialogueTurns(q);
    if (turns.length) {
      speakDialogueTurns(turns, {
        buttonId: "btn-play-listening",
        idleLabel: "▶ Phát hội thoại",
        speakingLabel: "■ Dừng",
      });
      return;
    }
    speakJapanese(buildListeningSpeakText(q), {
      buttonId: "btn-play-listening",
      idleLabel: "▶ Phát hội thoại",
      speakingLabel: "■ Dừng",
    });
  }

  function speakCurrentQuestion() {
    if (!activeExam) return;
    const q = activeExam.questions[currentIndex];
    if (!q) return;

    if (isListeningQuestion(q)) {
      const turns = parseDialogueTurns(q);
      if (turns.length) {
        speakDialogueTurns(turns, {
          buttonId: "btn-speak-question",
          idleLabel: "🔊 Phát lại",
          speakingLabel: "■ Dừng",
        });
        return;
      }
      speakJapanese(buildListeningSpeakText(q), {
        buttonId: "btn-speak-question",
        idleLabel: "🔊 Phát lại",
        speakingLabel: "■ Dừng",
      });
      return;
    }

    const key = String(q.question_id);
    const selectedChoice = answers[key];
    const text = buildSpeakText(q, selectedChoice);
    speakJapanese(text, {
      buttonId: "btn-speak-question",
      idleLabel: "🔊 Đọc câu",
      speakingLabel: "Đang đọc...",
    });
  }

  function loadProgress() {
    try {
      const raw = localStorage.getItem(PROGRESS_KEY);
      if (!raw) return { exams: {} };
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object"
        ? { exams: parsed.exams || {} }
        : { exams: {} };
    } catch {
      return { exams: {} };
    }
  }

  function saveProgress(progress) {
    localStorage.setItem(PROGRESS_KEY, JSON.stringify(progress));
  }

  function normalizeProgressShape(raw) {
    if (!raw || typeof raw !== "object") return { exams: {} };
    const exams = raw.exams && typeof raw.exams === "object" ? raw.exams : {};
    return { exams };
  }

  function exportProgress() {
    const payload = {
      version: 1,
      exportedAt: new Date().toISOString(),
      progress: loadProgress(),
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: "application/json;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    a.href = url;
    a.download = `nihongoshiken-progress-${stamp}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  function syncUiAfterProgressImport() {
    if (!catalog) return;
    if (activeExam) {
      const prog = getExamProgress(activeExam.id);
      answers = { ...(prog.answers || {}) };
      currentIndex = Math.min(
        prog.currentQuestionIndex || 0,
        Math.max(0, activeExam.questions.length - 1)
      );
      renderToc();
      renderQuestion();
      updateQuizStats();
    }
    renderDashboard();
  }

  function importProgressFromFile(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(String(reader.result || "{}"));
        const source = parsed.progress && typeof parsed.progress === "object"
          ? parsed.progress
          : parsed;
        const normalized = normalizeProgressShape(source);
        saveProgress(normalized);
        syncUiAfterProgressImport();
        alert("Import tiến độ thành công.");
      } catch (err) {
        console.error(err);
        alert("File tiến độ không hợp lệ.");
      }
    };
    reader.onerror = () => {
      alert("Không đọc được file.");
    };
    reader.readAsText(file, "utf-8");
  }

  function getExamProgress(examId) {
    const all = loadProgress();
    return all.exams[examId] || { currentQuestionIndex: 0, answers: {} };
  }

  function setExamProgress(examId, data) {
    const all = loadProgress();
    all.exams[examId] = data;
    saveProgress(all);
  }

  function clearExamProgress(examId) {
    const all = loadProgress();
    delete all.exams[examId];
    saveProgress(all);
  }

  function scoreForExam(examMeta) {
    const prog = getExamProgress(examMeta.id);
    const answerMap = prog.answers || {};
    const answered = Object.keys(answerMap).length;
    // correct count needs correct_answer; use cached exam if loaded, else only answered
    const cached = activeExam && activeExam.id === examMeta.id ? activeExam : null;
    let correct = 0;
    if (cached) {
      for (const q of cached.questions) {
        const key = String(q.question_id);
        if (answerMap[key] === undefined) continue;
        if (hasOfficialKey(q) && Number(answerMap[key]) === Number(q.correct_answer)) {
          correct += 1;
        }
      }
    } else {
      // Dashboard: store isCorrect flags if present; else we need sidecar.
      // We'll keep answers as number and recompute when opening; for dashboard
      // we store optional correctMap in progress when answering.
      const flags = prog.correctFlags || {};
      correct = Object.values(flags).filter(Boolean).length;
    }
    return {
      total: examMeta.questionCount || 0,
      answered,
      correct,
    };
  }

  function showView(name) {
    document.querySelectorAll(".view").forEach((el) => {
      el.classList.toggle("active", el.id === name);
    });
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function closeTopNavMenus() {
    const nav = $("top-nav");
    if (!nav) return;
    nav.querySelectorAll(".nav-group.open").forEach((g) => g.classList.remove("open"));
  }

  function renderTopNav() {
    const nav = $("top-nav-links");
    if (!nav || !catalog) return;

    const grouped = DataLoader.groupByTrackThenTopic(catalog.exams || []);
    const trackKeys = [
      ...TRACK_ORDER.filter((t) => grouped.has(t)),
      ...[...grouped.keys()].filter((t) => !TRACK_ORDER.includes(t)),
    ];

    let html = "";
    for (const track of trackKeys) {
      const topicMap = grouped.get(track);
      const topicKeys = [
        ...TOPIC_ORDER.filter((t) => topicMap.has(t)),
        ...[...topicMap.keys()].filter((t) => !TOPIC_ORDER.includes(t)),
      ];
      const sections = topicKeys
        .map((topic) => {
          const list = topicMap.get(topic) || [];
          const links = list
            .map(
              (exam) => `
              <button type="button" class="nav-link" data-exam-id="${exam.id}">
                <span class="nav-link-title">${exam.title}</span>
              </button>`
            )
            .join("");
          return `
            <section class="nav-topic">
              <h4 class="nav-topic-title">${TOPIC_LABELS[topic] || topic}</h4>
              <div class="nav-topic-list">${links}</div>
            </section>`;
        })
        .join("");

      html += `
        <div class="nav-group">
          <button type="button" class="nav-trigger">${TRACK_LABELS[track] || track}</button>
          <div class="nav-list">${sections}</div>
        </div>`;
    }

    nav.innerHTML = html;
    const isDesktop = () => window.matchMedia("(hover: hover) and (pointer: fine)").matches;
    nav.querySelectorAll(".nav-trigger").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const group = btn.closest(".nav-group");
        if (!group) return;
        const willOpen = !group.classList.contains("open");
        closeTopNavMenus();
        if (willOpen) group.classList.add("open");
      });
    });
    nav.querySelectorAll(".nav-group").forEach((group) => {
      group.addEventListener("mouseenter", () => {
        if (!isDesktop()) return;
        closeTopNavMenus();
        group.classList.add("open");
      });
      group.addEventListener("mouseleave", () => {
        if (!isDesktop()) return;
        group.classList.remove("open");
      });
    });
    nav.querySelectorAll(".nav-link").forEach((btn) => {
      btn.addEventListener("click", () => {
        closeTopNavMenus();
        if (document.activeElement instanceof HTMLElement) {
          document.activeElement.blur();
        }
        openExam(btn.dataset.examId);
      });
    });
  }

  function renderDashboard() {
    const root = $("dashboard-root");
    const exams = catalog.exams || [];
    const grouped = DataLoader.groupByTrackThenTopic(exams);

    const trackKeys = [
      ...TRACK_ORDER.filter((t) => grouped.has(t)),
      ...[...grouped.keys()].filter((t) => !TRACK_ORDER.includes(t)),
    ];

    let html = "";
    for (const track of trackKeys) {
      const topicMap = grouped.get(track);
      html += `<section class="track-block">`;
      html += `<h2 class="track-title">${TRACK_LABELS[track] || track}</h2>`;
      html += `<p class="track-desc">${TRACK_DESCRIPTIONS[track] || ""}</p>`;

      const topicKeys = [
        ...TOPIC_ORDER.filter((t) => topicMap.has(t)),
        ...[...topicMap.keys()].filter((t) => !TOPIC_ORDER.includes(t)),
      ];

      for (const topic of topicKeys) {
        const list = topicMap.get(topic);
        html += `<div class="topic-block" data-topic="${topic}">`;
        html += `<h3 class="topic-title">${TOPIC_LABELS[topic] || topic}</h3>`;
        html += `<div class="exam-grid">`;
        for (const exam of list) {
          const s = scoreForExam(exam);
          const scoreClass = s.answered ? "score" : "score empty";
          const scoreText = s.answered
            ? `Đúng ${s.correct}/${s.total}`
            : "Chưa làm";
          const okPct = s.total ? (s.correct / s.total) * 100 : 0;
          const badPct = s.total
            ? ((s.answered - s.correct) / s.total) * 100
            : 0;
          html += `
            <div class="exam-card" data-exam-id="${exam.id}" data-topic="${exam.topic || topic}" tabindex="0" role="button">
              <button type="button" class="exam-code" data-code="${exam.code || exam.id}" title="Nhấn để copy mã đề">${exam.code || exam.id}</button>
              <h3>${exam.title}</h3>
              <div class="meta">
                <span>${exam.questionCount} câu</span>
                <span class="${scoreClass}">${scoreText}</span>
              </div>
              <div class="progress-bar" aria-hidden="true">
                <div class="ok" style="width:${okPct}%"></div>
                <div class="bad" style="width:${badPct}%"></div>
              </div>
            </div>`;
        }
        html += `</div></div>`;
      }
      html += `</section>`;
    }

    root.innerHTML = html || `<div class="status-banner">Chưa có đề nào trong catalog.</div>`;

    const totalQ = exams.reduce((n, e) => n + (e.questionCount || 0), 0);
    $("header-meta").textContent = `${exams.length} đề · ${totalQ} câu`;
    renderTopNav();

    root.querySelectorAll(".exam-card").forEach((card) => {
      card.addEventListener("click", () => openExam(card.dataset.examId));
      card.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          openExam(card.dataset.examId);
        }
      });
    });
    bindExamCodeCopy(root);
  }

  async function openExam(examId) {
    const meta = (catalog.exams || []).find((e) => e.id === examId);
    if (!meta) return;
    closeTopNavMenus();
    stopSpeech();

    $("quiz-body").innerHTML = `<div class="status-banner">Đang tải đề...</div>`;
    showView("quiz-view");

    try {
      const exam = await DataLoader.loadExam(meta);
      activeMeta = meta;
      activeExam = exam;
      const prog = getExamProgress(examId);
      answers = { ...(prog.answers || {}) };
      currentIndex = Math.min(
        prog.currentQuestionIndex || 0,
        Math.max(0, (exam.questions || []).length - 1)
      );
      const code = exam.code || exam.id;
      $("quiz-code").textContent = code;
      $("quiz-code").dataset.code = code;
      $("quiz-title").textContent = exam.title;
      renderToc();
      renderQuestion();
      updateQuizStats();
    } catch (err) {
      console.error(err);
      $("quiz-body").innerHTML = `<div class="status-banner error">${err.message}</div>`;
    }
  }

  function persistActive() {
    if (!activeExam) return;
    const correctFlags = {};
    for (const q of activeExam.questions) {
      const key = String(q.question_id);
      if (answers[key] === undefined) continue;
      correctFlags[key] = hasOfficialKey(q)
        ? Number(answers[key]) === Number(q.correct_answer)
        : false;
    }
    setExamProgress(activeExam.id, {
      currentQuestionIndex: currentIndex,
      answers: { ...answers },
      correctFlags,
    });
  }

  function computeScore() {
    if (!activeExam) return { total: 0, answered: 0, correct: 0 };
    const total = activeExam.questions.length;
    let answered = 0;
    let correct = 0;
    for (const q of activeExam.questions) {
      const key = String(q.question_id);
      if (answers[key] === undefined) continue;
      answered += 1;
      if (hasOfficialKey(q) && Number(answers[key]) === Number(q.correct_answer)) {
        correct += 1;
      }
    }
    return { total, answered, correct };
  }

  function updateQuizStats() {
    const s = computeScore();
    $("stat-correct").textContent = String(s.correct);
    $("stat-answered").textContent = `${s.answered}/${s.total}`;
  }

  function questionDisplayLabel(q, idx) {
    if (q && q.label) return String(q.label);
    if (q && Number(q.question_id) === 0) return "練習";
    if (q && q.question_id !== undefined && q.question_id !== null) {
      return String(q.question_id);
    }
    return String(idx + 1);
  }

  function renderToc() {
    const toc = $("toc");
    toc.innerHTML = "";
    toc.style.setProperty("--toc-cols", String(activeExam.questions.length));
    activeExam.questions.forEach((q, idx) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "toc-btn";
      btn.textContent = questionDisplayLabel(q, idx);
      btn.dataset.index = String(idx);
      const key = String(q.question_id);
      if (answers[key] !== undefined) {
        if (!hasOfficialKey(q)) btn.classList.add("picked");
        else {
          btn.classList.add(
            Number(answers[key]) === Number(q.correct_answer)
              ? "correct"
              : "incorrect"
          );
        }
      }
      if (idx === currentIndex) btn.classList.add("current");
      btn.addEventListener("click", () => {
        currentIndex = idx;
        persistActive();
        renderToc();
        renderQuestion();
        updateQuizStats();
      });
      toc.appendChild(btn);
    });
  }

  function speakerLabel(role) {
    if (role === "male") return "男";
    if (role === "female") return "女";
    return "";
  }

  function formatTranscript(q) {
    const turns = parseDialogueTurns(q);
    if (!turns.length) return "";

    return turns
      .map((turn) => {
        const who = speakerLabel(turn.role);
        const jp = who ? `${who}：${turn.text}` : turn.text;
        const vi = turn.vi
          ? `<p class="transcript-vi">${escapeHtml(turn.vi)}</p>`
          : "";
        return `<div class="transcript-turn">
          <p class="transcript-line">${escapeHtml(jp)}</p>
          ${vi}
        </div>`;
      })
      .join("");
  }

  function renderQuestion() {
    const q = activeExam.questions[currentIndex];
    if (!q) return;

    const key = String(q.question_id);
    const selected = answers[key];
    const hasAnswer = selected !== undefined;
    const listening = isListeningQuestion(q);

    let passageHtml = "";
    if (q.context) {
      passageHtml = `
        <div class="passage">
          <div class="passage-label">Ngữ cảnh</div>
          ${formatPassage(q.context)}
        </div>`;
    }

    let listeningHtml = "";
    if (listening) {
      const mediaImage =
        q.media && q.media.image
          ? `<img class="listening-image" src="data/${escapeHtml(q.media.image)}" alt="Minh họa câu hỏi" />`
          : "";
      const mediaAudio =
        q.media && q.media.audio
          ? `<audio class="listening-audio" controls src="data/${escapeHtml(q.media.audio)}"></audio>`
          : "";
      listeningHtml = `
        <div class="listening-box">
          ${mediaImage}
          <div class="listening-controls">
            ${
              mediaAudio ||
              `<button type="button" class="btn btn-primary" id="btn-play-listening">▶ Phát hội thoại</button>`
            }
            <span class="listening-hint">Nghe rồi chọn đáp án.</span>
          </div>
        </div>`;
    }

    const optionsHtml = (q.options || [])
      .map((text, i) => {
        const num = i + 1;
        let cls = "option";
        if (hasAnswer) {
          if (!hasOfficialKey(q)) {
            cls += num === Number(selected) ? " picked" : " dim";
          } else if (num === Number(q.correct_answer)) cls += " correct";
          else if (num === Number(selected)) cls += " incorrect";
          else cls += " dim";
        }
        return `
          <button type="button" class="${cls}" data-choice="${num}" ${
          hasAnswer ? "disabled" : ""
        }>
            <span class="idx">${num}</span>
            <span class="label">${text}</span>
          </button>`;
      })
      .join("");

    const transcriptHtml =
      listening && hasAnswer && parseDialogueTurns(q).length
        ? `<div class="transcript">
            <div class="transcript-head">
              <div class="passage-label">Transcript</div>
              <button type="button" class="btn btn-ghost btn-speak" id="btn-speak-question">🔊 Phát lại</button>
            </div>
            ${formatTranscript(q)}
          </div>`
        : "";

    $("quiz-body").innerHTML = `
      <div class="panel">
        <div class="q-head">
          <span class="q-num">${escapeHtml(questionDisplayLabel(q, currentIndex))}</span>
          <button type="button" class="btn btn-ghost btn-copy-prompt" id="btn-copy-prompt">Copy prompt</button>
        </div>
        ${passageHtml}
        ${listeningHtml}
        <div class="q-text">${q.question}</div>
        <div class="options" id="options">${optionsHtml}</div>
        ${
          String(q.explanation || "").trim()
            ? `<div class="explain ${hasAnswer ? "show" : ""}" id="explain">
          <div class="explain-head">
            <h4>Giải thích</h4>
            ${
              hasAnswer && !listening
                ? '<button type="button" class="btn btn-ghost btn-speak" id="btn-speak-question">🔊 Đọc câu</button>'
                : ""
            }
          </div>
          <div class="explain-body">${q.explanation}</div>
        </div>`
            : ""
        }
        ${transcriptHtml}
      </div>
      <div class="quiz-nav">
        <button type="button" class="btn" id="btn-prev" ${
          currentIndex === 0 ? "disabled" : ""
        }>← Câu trước</button>
        <button type="button" class="btn btn-primary" id="btn-next" ${
          currentIndex >= activeExam.questions.length - 1 ? "disabled" : ""
        }>Câu tiếp →</button>
      </div>`;

    $("options").querySelectorAll(".option").forEach((btn) => {
      btn.addEventListener("click", () => selectAnswer(Number(btn.dataset.choice)));
    });
    $("btn-prev").addEventListener("click", () => navigate(-1));
    $("btn-next").addEventListener("click", () => navigate(1));
    $("btn-copy-prompt").addEventListener("click", copyPrompt);
    const playBtn = $("btn-play-listening");
    if (playBtn) playBtn.addEventListener("click", speakListeningAudio);
    const speakBtn = $("btn-speak-question");
    if (speakBtn) speakBtn.addEventListener("click", speakCurrentQuestion);
  }

  function selectAnswer(choice) {
    const q = activeExam.questions[currentIndex];
    const key = String(q.question_id);
    if (answers[key] !== undefined) return;
    stopSpeech();
    answers[key] = choice;
    persistActive();
    renderToc();
    renderQuestion();
    updateQuizStats();
  }

  function navigate(delta) {
    const next = currentIndex + delta;
    if (next < 0 || next >= activeExam.questions.length) return;
    stopSpeech();
    currentIndex = next;
    persistActive();
    renderToc();
    renderQuestion();
    updateQuizStats();
  }

  function buildPrompt(q, index) {
    const lines = [
      "Hãy giải thích chi tiết câu hỏi JLPT sau bằng tiếng Việt:",
      "",
      `${questionDisplayLabel(q, index)}: ${q.question}`,
    ];
    if (q.context) {
      lines.push("", `Ngữ cảnh: ${q.context}`);
    }
    if (q.dialogue || q.transcript) {
      const turns = parseDialogueTurns(q);
      if (turns.length) {
        lines.push("", "Transcript:");
        turns.forEach((t) => {
          const who = speakerLabel(t.role);
          lines.push(who ? `${who}：${t.text}` : t.text);
          if (t.vi) lines.push(`  (${t.vi})`);
        });
      } else if (q.transcript) {
        lines.push("", `Transcript: ${q.transcript}`);
      }
    }
    lines.push("", "Các lựa chọn:");
    (q.options || []).forEach((opt, i) => {
      lines.push(`${i + 1}. ${opt}`);
    });
    if (q.correct_answer) {
      lines.push("", `Đáp án đúng hiện có: ${q.correct_answer}`);
    }
    if (q.explanation) {
      lines.push("", "Giải thích hiện có:", q.explanation);
    }
    lines.push(
      "",
      "Yêu cầu: giải thích vì sao đáp án đúng, vì sao các đáp án khác sai, và đưa ví dụ ngắn nếu phù hợp."
    );
    return lines.join("\n");
  }

  async function writeClipboard(text) {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return;
    }
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.left = "-9999px";
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }

  async function copyExamCode(code, btn) {
    if (!code || !btn) return;
    const original = btn.textContent;
    try {
      await writeClipboard(code);
      btn.textContent = "Copied";
      btn.classList.add("copied");
      setTimeout(() => {
        btn.textContent = original;
        btn.classList.remove("copied");
      }, 1400);
    } catch (err) {
      console.error(err);
      btn.textContent = "Lỗi";
      setTimeout(() => {
        btn.textContent = original;
      }, 1800);
    }
  }

  function bindExamCodeCopy(root = document) {
    root.querySelectorAll(".exam-code[data-code]").forEach((btn) => {
      if (btn.dataset.copyBound === "1") return;
      btn.dataset.copyBound = "1";
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        copyExamCode(btn.dataset.code || btn.textContent.trim(), btn);
      });
    });
  }

  async function copyPrompt() {
    const q = activeExam.questions[currentIndex];
    const btn = $("btn-copy-prompt");
    const original = btn.textContent;
    try {
      await writeClipboard(buildPrompt(q, currentIndex));
      btn.textContent = "Copied";
      setTimeout(() => {
        btn.textContent = original;
      }, 1400);
    } catch (err) {
      console.error(err);
      btn.textContent = "Copy failed";
      setTimeout(() => {
        btn.textContent = original;
      }, 1800);
    }
  }

  function resetActiveExam() {
    if (!activeExam) return;
    if (!confirm("Xóa toàn bộ tiến độ đề này trên máy anh?")) return;
    answers = {};
    currentIndex = 0;
    clearExamProgress(activeExam.id);
    renderToc();
    renderQuestion();
    updateQuizStats();
  }

  function goDashboard() {
    stopSpeech();
    activeExam = null;
    activeMeta = null;
    renderDashboard();
    showView("dashboard-view");
  }

  async function init() {
    $("btn-back").addEventListener("click", goDashboard);
    $("brand").addEventListener("click", goDashboard);
    $("btn-reset").addEventListener("click", resetActiveExam);
    $("quiz-code").addEventListener("click", (e) => {
      e.preventDefault();
      const btn = $("quiz-code");
      copyExamCode(btn.dataset.code || btn.textContent.trim(), btn);
    });
    $("btn-export-progress").addEventListener("click", () => {
      closeTopNavMenus();
      exportProgress();
    });
    $("btn-import-progress").addEventListener("click", () => {
      closeTopNavMenus();
      const input = $("progress-import-file");
      if (!input) return;
      input.value = "";
      input.click();
    });
    $("progress-import-file").addEventListener("change", (e) => {
      const input = e.target;
      const file = input.files && input.files[0] ? input.files[0] : null;
      importProgressFromFile(file);
    });
    const progressMenuTrigger = document.querySelector("#progress-menu-group .nav-trigger");
    if (progressMenuTrigger) {
      progressMenuTrigger.addEventListener("click", (e) => {
        e.stopPropagation();
        const group = $("progress-menu-group");
        if (!group) return;
        const willOpen = !group.classList.contains("open");
        closeTopNavMenus();
        if (willOpen) group.classList.add("open");
      });
    }
    document.addEventListener("click", (e) => {
      const nav = $("top-nav");
      if (!nav) return;
      if (!nav.contains(e.target)) {
        closeTopNavMenus();
      }
    });
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      closeTopNavMenus();
    });

    try {
      catalog = await DataLoader.loadCatalog();
      renderTopNav();
      renderDashboard();
      showView("dashboard-view");
    } catch (err) {
      console.error(err);
      $("dashboard-root").innerHTML = `<div class="status-banner error">${err.message}<br>Hãy chạy local server trong thư mục src (ví dụ: python -m http.server 5500).</div>`;
      showView("dashboard-view");
    }
  }

  document.addEventListener("DOMContentLoaded", init);
})();
