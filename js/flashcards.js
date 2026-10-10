/**
 * ========================================================
 * NIHONGOSHIKEN FLASHCARDS ENGINE
 * Pure Vanilla JavaScript, Zero External Runtime Dependencies,
 * Spaced Repetition (SRS), 3D Interactive Card Player,
 * Web Speech TTS, Catalog Loading & Offline LocalStorage Sync
 * ========================================================
 */

(() => {
  const PROGRESS_KEY = "nihongoshiken_flashcard_progress_v1";
  const USER_DECKS_KEY = "nihongoshiken_user_decks_v1";

  // STATE
  let catalogDecks = [];
  let userDecks = [];
  let activeDeck = null;
  let currentCardIndex = 0;
  let isFlipped = false;
  let isJpToVi = true;
  let currentFilterType = "all";
  let currentFilterLevel = "all";
  let currentSearchQuery = "";
  let isReviewOnlyMode = false;
  let studyQueue = [];

  const $ = (id) => document.getElementById(id);

  const TYPE_CONFIG = {
    vocabulary: {
      label: "Từ vựng",
      badgeClass: "vocabulary",
      stripeClass: "vocabulary",
      icon: "🔤"
    },
    kanji: {
      label: "Hán tự",
      badgeClass: "kanji",
      stripeClass: "kanji",
      icon: "⛩️"
    },
    grammar: {
      label: "Ngữ pháp",
      badgeClass: "grammar",
      stripeClass: "grammar",
      icon: "📌"
    }
  };

  // ========================================================
  // SPEECH SYNTHESIS HELPER (JAPANESE)
  // ========================================================
  function speakJapanese(text, btnElement = null) {
    if (!("speechSynthesis" in window) || !text) return;
    window.speechSynthesis.cancel();

    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = "ja-JP";
    utterance.rate = 0.9;
    utterance.pitch = 1.0;

    const voices = window.speechSynthesis.getVoices().filter(v => v.lang && v.lang.toLowerCase().startsWith("ja"));
    if (voices.length > 0) utterance.voice = voices[0];

    if (btnElement) {
      btnElement.classList.add("is-speaking");
      utterance.onend = () => btnElement.classList.remove("is-speaking");
      utterance.onerror = () => btnElement.classList.remove("is-speaking");
    }

    window.speechSynthesis.speak(utterance);
  }

  // ========================================================
  // PROGRESS & LOCAL STORAGE
  // ========================================================
  function loadProgress() {
    try {
      const raw = localStorage.getItem(PROGRESS_KEY);
      return raw ? JSON.parse(raw) : { cardStats: {}, history: [] };
    } catch {
      return { cardStats: {}, history: [] };
    }
  }

  function saveProgress(prog) {
    try {
      localStorage.setItem(PROGRESS_KEY, JSON.stringify(prog));
    } catch (e) {
      console.error("Failed to save progress to localStorage", e);
    }
  }

  function recordCardReview(deckId, cardId, rating) {
    const prog = loadProgress();
    const key = `${deckId}:${cardId}`;
    const now = Date.now();
    const prev = prog.cardStats[key] || { status: "new", reviews: 0 };

    let nextStatus = "learning";
    if (rating === 3) nextStatus = "mastered";
    else if (rating === 1) nextStatus = "again";

    prog.cardStats[key] = {
      status: nextStatus,
      reviews: prev.reviews + 1,
      lastReviewed: now,
      rating
    };

    prog.history.push({ key, rating, timestamp: now });
    if (prog.history.length > 2000) prog.history.shift();

    saveProgress(prog);
    updateGlobalStats();
  }

  function getDeckProgress(deck) {
    if (!deck) return { mastered: 0, learning: 0, total: 0 };
    const prog = loadProgress();
    let mastered = 0;
    let learning = 0;
    const cards = deck.cards || [];
    const total = deck.cardCount || cards.length;

    cards.forEach((c, idx) => {
      const cid = c.id || `c_${idx}`;
      const stat = prog.cardStats[`${deck.id}:${cid}`];
      if (stat) {
        if (stat.status === "mastered") mastered++;
        else if (stat.status === "learning" || stat.status === "again") learning++;
      }
    });

    return { mastered, learning, total };
  }

  function updateGlobalStats() {
    const prog = loadProgress();
    const stats = Object.values(prog.cardStats);
    const mastered = stats.filter(s => s.status === "mastered").length;
    const learning = stats.filter(s => s.status === "learning" || s.status === "again").length;

    if ($("stat-mastered")) $("stat-mastered").textContent = mastered;
    if ($("stat-learning")) $("stat-learning").textContent = learning;
    if ($("stat-total-learned")) $("stat-total-learned").textContent = mastered + learning;
  }

  // ========================================================
  // DATA LOADING
  // ========================================================
  async function loadFlashcardCatalog() {
    try {
      const res = await fetch("data/flashcards/catalog.json", { cache: "no-cache" });
      if (res.ok) {
        const data = await res.json();
        catalogDecks = data.decks || [];
      }
    } catch (e) {
      console.warn("Could not fetch data/flashcards/catalog.json, falling back", e);
    }

    try {
      const rawUserDecks = localStorage.getItem(USER_DECKS_KEY);
      if (rawUserDecks) {
        userDecks = JSON.parse(rawUserDecks) || [];
      }
    } catch (e) {
      console.warn("Error reading user decks", e);
    }
  }

  async function loadDeckContent(deck) {
    if (deck.cards && deck.cards.length > 0) return deck;

    if (deck.file) {
      try {
        const res = await fetch(`data/${deck.file}`, { cache: "no-cache" });
        if (res.ok) {
          const content = await res.json();
          deck.cards = content.cards || [];
          return deck;
        }
      } catch (err) {
        console.error("Error loading deck cards from file:", deck.file, err);
      }
    }

    return deck;
  }

  function getAllDecks() {
    return [...catalogDecks, ...userDecks];
  }

  // ========================================================
  // RENDER DECKS LIST
  // ========================================================
  function renderDecks() {
    const all = getAllDecks();
    const filtered = all.filter(deck => {
      const matchesType = currentFilterType === "all" || deck.type === currentFilterType;
      const matchesLevel = currentFilterLevel === "all" || deck.level === currentFilterLevel;
      const query = currentSearchQuery.toLowerCase().trim();
      const matchesSearch = !query ||
        (deck.title && deck.title.toLowerCase().includes(query)) ||
        (deck.description && deck.description.toLowerCase().includes(query)) ||
        (deck.level && deck.level.toLowerCase().includes(query));
      return matchesType && matchesLevel && matchesSearch;
    });

    const countEl = $("visible-count");
    if (countEl) countEl.textContent = filtered.length;

    const container = $("decks-container");
    const emptyState = $("empty-state");

    if (filtered.length === 0) {
      if (container) container.innerHTML = "";
      if (emptyState) emptyState.style.display = "block";
      return;
    }

    if (emptyState) emptyState.style.display = "none";

    let html = "";
    filtered.forEach(deck => {
      const conf = TYPE_CONFIG[deck.type] || TYPE_CONFIG.vocabulary;
      const prog = getDeckProgress(deck);
      const masteredPct = prog.total ? Math.round((prog.mastered / prog.total) * 100) : 0;
      const learningPct = prog.total ? Math.round((prog.learning / prog.total) * 100) : 0;

      html += `
        <div class="fc-card">
          <!-- Top Accent Stripe -->
          <div class="fc-card-stripe ${conf.stripeClass}"></div>

          <!-- Card Content -->
          <div class="fc-card-content">
            <div>
              <div class="fc-card-badges">
                <div style="display:flex; align-items:center; gap:6px;">
                  <span class="fc-badge ${conf.badgeClass}">
                    ${conf.icon} ${conf.label}
                  </span>
                  <span class="fc-badge level">
                    ${deck.level || "JLPT"}
                  </span>
                </div>
                <span class="fc-card-count">${deck.cardCount || (deck.cards ? deck.cards.length : 0)} thẻ</span>
              </div>

              <h3 class="fc-card-title">${deck.title}</h3>
              <p class="fc-card-desc">${deck.description || "Bộ thẻ ghi nhớ chuyên sâu."}</p>
            </div>

            <!-- Progress Bar -->
            <div class="fc-card-progress">
              <div class="fc-progress-meta">
                <span>Tiến độ ghi nhớ</span>
                <strong>${masteredPct}% (${prog.mastered}/${prog.total})</strong>
              </div>
              <div class="fc-progress-track">
                <div class="fc-progress-fill-mastered" style="width: ${masteredPct}%;" title="Đã thuộc: ${prog.mastered}"></div>
                <div class="fc-progress-fill-learning" style="width: ${learningPct}%;" title="Đang học: ${prog.learning}"></div>
              </div>
            </div>
          </div>

          <!-- Card Actions -->
          <div class="fc-card-actions">
            <button type="button" class="fc-btn-study" onclick="window.openStudyPlayer('${deck.id}', false)">
              <span>⚡ Học ngay</span>
            </button>
            <button type="button" class="fc-btn-review" onclick="window.openStudyPlayer('${deck.id}', true)" title="Ôn tập thẻ chưa thuộc">
              <span>🔄 Ôn tập</span>
            </button>
          </div>
        </div>
      `;
    });

    if (container) container.innerHTML = html;
  }

  // ========================================================
  // STUDY PLAYER (MODAL)
  // ========================================================
  window.openStudyPlayer = async function(deckId, reviewOnly = false) {
    const all = getAllDecks();
    const baseDeck = all.find(d => d.id === deckId);
    if (!baseDeck) return;

    activeDeck = await loadDeckContent(baseDeck);
    if (!activeDeck || !activeDeck.cards || activeDeck.cards.length === 0) {
      alert("Bộ thẻ này hiện chưa có nội dung thẻ.");
      return;
    }

    isReviewOnlyMode = reviewOnly;
    const prog = loadProgress();

    if (reviewOnly) {
      studyQueue = activeDeck.cards.filter((c, idx) => {
        const cid = c.id || `c_${idx}`;
        const stat = prog.cardStats[`${activeDeck.id}:${cid}`];
        return !stat || stat.status !== "mastered";
      });
      if (studyQueue.length === 0) {
        alert("🎉 Tuyệt vời! Bạn đã thuộc tất cả các thẻ trong bộ này. Hệ thống sẽ mở toàn bộ để bạn ôn lại.");
        studyQueue = [...activeDeck.cards];
      }
    } else {
      studyQueue = [...activeDeck.cards];
    }

    currentCardIndex = 0;
    isFlipped = false;
    renderCurrentCard();

    const modal = $("study-modal");
    if (modal) modal.classList.remove("hidden");
  };

  function closeStudyPlayer() {
    const modal = $("study-modal");
    if (modal) modal.classList.add("hidden");
    activeDeck = null;
    studyQueue = [];
    if ("speechSynthesis" in window) window.speechSynthesis.cancel();
    renderDecks();
  }

  function renderCurrentCard() {
    if (!activeDeck || !studyQueue || studyQueue.length === 0) return;
    const card = studyQueue[currentCardIndex];
    const total = studyQueue.length;

    // Badge & Deck Title
    const conf = TYPE_CONFIG[activeDeck.type] || TYPE_CONFIG.vocabulary;
    const badge = $("player-badge");
    if (badge) {
      badge.className = `fc-badge ${conf.badgeClass}`;
      badge.textContent = `${activeDeck.level || "JLPT"} · ${conf.label}`;
    }

    const titleEl = $("player-deck-title");
    if (titleEl) titleEl.textContent = activeDeck.title;

    const counterEl = $("player-counter");
    if (counterEl) counterEl.textContent = `Thẻ ${currentCardIndex + 1} / ${total}`;

    const progBar = $("player-progress-bar");
    if (progBar) {
      const pct = Math.round(((currentCardIndex + 1) / total) * 100);
      progBar.style.width = `${pct}%`;
    }

    // Reset flip
    isFlipped = false;
    const flashcardEl = $("flashcard-element");
    if (flashcardEl) flashcardEl.classList.remove("rotate-y-180");

    // Direction handling
    const cardTerm = $("card-term");
    const cardFrontHint = $("card-front-hint");
    const cardReading = $("card-reading");
    const cardMeaning = $("card-meaning");
    const labelDirection = $("label-direction");

    if (isJpToVi) {
      if (cardTerm) cardTerm.textContent = card.term;
      if (cardFrontHint) {
        cardFrontHint.textContent = card.hanviet ? `(Gợi ý: ${card.hanviet})` : `(${activeDeck.title})`;
      }
      if (cardReading) cardReading.textContent = card.reading || "";
      if (cardMeaning) cardMeaning.textContent = card.meaning || "";
      if (labelDirection) labelDirection.textContent = "Nhật ➔ Việt";
    } else {
      if (cardTerm) cardTerm.textContent = card.meaning;
      if (cardFrontHint) cardFrontHint.textContent = "Nhớ lại cách đọc và từ tiếng Nhật";
      if (cardReading) cardReading.textContent = card.reading || "";
      if (cardMeaning) cardMeaning.textContent = card.term;
      if (labelDirection) labelDirection.textContent = "Việt ➔ Nhật";
    }

    // Han-Viet
    const hanvietWrap = $("card-hanviet-wrap");
    const hanvietEl = $("card-hanviet");
    if (card.hanviet && hanvietWrap && hanvietEl) {
      hanvietWrap.style.display = "inline-block";
      hanvietEl.textContent = card.hanviet;
    } else if (hanvietWrap) {
      hanvietWrap.style.display = "none";
    }

    // Formation Rule (Grammar)
    const formationWrap = $("card-formation-wrap");
    const formationEl = $("card-formation");
    if (card.formation && formationWrap && formationEl) {
      formationWrap.style.display = "block";
      formationEl.textContent = card.formation;
    } else if (formationWrap) {
      formationWrap.style.display = "none";
    }

    // Example Sentence
    const exampleWrap = $("card-example-wrap");
    const exampleJa = $("card-example-ja");
    const exampleVi = $("card-example-vi");
    if (card.example && exampleWrap && exampleJa) {
      exampleWrap.style.display = "block";
      exampleJa.textContent = card.example;
      if (exampleVi) exampleVi.textContent = card.exampleVi || "";
    } else if (exampleWrap) {
      exampleWrap.style.display = "none";
    }

    // Navigation buttons state
    const btnPrev = $("btn-prev-card");
    const btnNext = $("btn-next-card");
    if (btnPrev) btnPrev.disabled = currentCardIndex === 0;
    if (btnNext) {
      btnNext.disabled = false;
      btnNext.title = currentCardIndex === total - 1 ? "Hoàn thành phiên học" : "Thẻ tiếp theo (Phím →)";
    }
  }

  function flipCard() {
    isFlipped = !isFlipped;
    const flashcardEl = $("flashcard-element");
    if (flashcardEl) flashcardEl.classList.toggle("rotate-y-180", isFlipped);
  }

  function prevCard() {
    if (currentCardIndex > 0) {
      currentCardIndex--;
      renderCurrentCard();
    }
  }

  function nextCard() {
    if (!studyQueue || studyQueue.length === 0) return;
    if (currentCardIndex < studyQueue.length - 1) {
      currentCardIndex++;
      renderCurrentCard();
    } else {
      alert("🎉 Chúc mừng bạn đã hoàn thành phiên học thẻ này!");
      closeStudyPlayer();
    }
  }

  function rateCard(rating) {
    if (!activeDeck || !studyQueue || studyQueue.length === 0) return;
    const card = studyQueue[currentCardIndex];
    const cid = card.id || `c_${currentCardIndex}`;
    recordCardReview(activeDeck.id, cid, rating);
    nextCard();
  }

  // ========================================================
  // EVENT LISTENERS & SHORTCUTS
  // ========================================================
  function setupEventListeners() {
    // 3D Card Click to Flip
    const flashcardEl = $("flashcard-element");
    if (flashcardEl) flashcardEl.addEventListener("click", flipCard);

    // Prev / Next buttons
    const btnPrev = $("btn-prev-card");
    const btnNext = $("btn-next-card");
    if (btnPrev) btnPrev.addEventListener("click", prevCard);
    if (btnNext) btnNext.addEventListener("click", nextCard);

    // Rating buttons
    const btnAgain = $("btn-rating-again");
    const btnHard = $("btn-rating-hard");
    const btnGood = $("btn-rating-good");
    if (btnAgain) btnAgain.addEventListener("click", () => rateCard(1));
    if (btnHard) btnHard.addEventListener("click", () => rateCard(2));
    if (btnGood) btnGood.addEventListener("click", () => rateCard(3));

    // Direction Toggle
    const btnDir = $("btn-toggle-direction");
    if (btnDir) {
      btnDir.addEventListener("click", () => {
        isJpToVi = !isJpToVi;
        renderCurrentCard();
      });
    }

    // Speech: Front
    const btnSpeakFront = $("btn-speak-front");
    if (btnSpeakFront) {
      btnSpeakFront.addEventListener("click", (e) => {
        e.stopPropagation();
        if (!activeDeck || !studyQueue.length) return;
        const card = studyQueue[currentCardIndex];
        speakJapanese(isJpToVi ? card.term : card.reading || card.term, btnSpeakFront);
      });
    }

    // Speech: Back Term
    const btnSpeakBack = $("btn-speak-back");
    if (btnSpeakBack) {
      btnSpeakBack.addEventListener("click", (e) => {
        e.stopPropagation();
        if (!activeDeck || !studyQueue.length) return;
        const card = studyQueue[currentCardIndex];
        speakJapanese(card.reading || card.term, btnSpeakBack);
      });
    }

    // Speech: Example Sentence
    const btnSpeakExample = $("btn-speak-example");
    if (btnSpeakExample) {
      btnSpeakExample.addEventListener("click", (e) => {
        e.stopPropagation();
        if (!activeDeck || !studyQueue.length) return;
        const card = studyQueue[currentCardIndex];
        if (card && card.example) {
          speakJapanese(card.example, btnSpeakExample);
        }
      });
    }

    // Close Player
    const btnClosePlayer = $("btn-close-player");
    if (btnClosePlayer) btnClosePlayer.addEventListener("click", closeStudyPlayer);

    // Help Popover
    const btnHelp = $("btn-help-shortcuts");
    const helpPopover = $("help-popover");
    const btnCloseHelp = $("btn-close-help");
    if (btnHelp && helpPopover) {
      btnHelp.addEventListener("click", (e) => {
        e.stopPropagation();
        helpPopover.classList.toggle("hidden");
      });
      if (btnCloseHelp) {
        btnCloseHelp.addEventListener("click", (e) => {
          e.stopPropagation();
          helpPopover.classList.add("hidden");
        });
      }
      document.addEventListener("click", (e) => {
        if (!helpPopover.contains(e.target) && e.target !== btnHelp) {
          helpPopover.classList.add("hidden");
        }
      });
    }

    // Search Input
    const searchInput = $("search-input");
    if (searchInput) {
      searchInput.addEventListener("input", (e) => {
        currentSearchQuery = e.target.value;
        renderDecks();
      });
    }

    // Filter Buttons: Level
    document.querySelectorAll(".filter-btn-level").forEach(btn => {
      btn.addEventListener("click", () => {
        document.querySelectorAll(".filter-btn-level").forEach(b => b.classList.remove("active"));
        btn.classList.add("active");
        currentFilterLevel = btn.dataset.level || "all";
        renderDecks();
      });
    });

    // Filter Buttons: Type
    document.querySelectorAll(".filter-btn-type").forEach(btn => {
      btn.addEventListener("click", () => {
        document.querySelectorAll(".filter-btn-type").forEach(b => b.classList.remove("active"));
        btn.classList.add("active");
        currentFilterType = btn.dataset.type || "all";
        renderDecks();
      });
    });

    // Reset Filters button in Empty State
    const btnResetFilters = $("btn-reset-filters");
    if (btnResetFilters) {
      btnResetFilters.addEventListener("click", () => {
        currentFilterType = "all";
        currentFilterLevel = "all";
        currentSearchQuery = "";
        if (searchInput) searchInput.value = "";
        document.querySelectorAll(".filter-btn-level").forEach(b => b.classList.toggle("active", b.dataset.level === "all"));
        document.querySelectorAll(".filter-btn-type").forEach(b => b.classList.toggle("active", b.dataset.type === "all"));
        renderDecks();
      });
    }

    // Top Progress Menu dropdown toggle
    const progressTrigger = $("btn-progress-trigger");
    const progressGroup = $("progress-menu-group");
    if (progressTrigger && progressGroup) {
      progressTrigger.addEventListener("click", (e) => {
        e.stopPropagation();
        progressGroup.classList.toggle("open");
      });
      document.addEventListener("click", (e) => {
        if (!progressGroup.contains(e.target)) progressGroup.classList.remove("open");
      });
    }

    // KEYBOARD SHORTCUTS
    document.addEventListener("keydown", (e) => {
      const modal = $("study-modal");
      if (!modal || modal.classList.contains("hidden")) return;

      if (e.key === "Escape") {
        e.preventDefault();
        closeStudyPlayer();
        return;
      }
      if (e.code === "Space" && e.target.tagName !== "INPUT" && e.target.tagName !== "TEXTAREA") {
        e.preventDefault();
        flipCard();
        return;
      }
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        prevCard();
        return;
      }
      if (e.key === "ArrowRight") {
        e.preventDefault();
        nextCard();
        return;
      }
      if (e.key === "1") {
        e.preventDefault();
        rateCard(1);
        return;
      }
      if (e.key === "2") {
        e.preventDefault();
        rateCard(2);
        return;
      }
      if (e.key === "3") {
        e.preventDefault();
        rateCard(3);
        return;
      }
    });

    // Import / Export Progress
    const btnExport = $("btn-export-progress");
    if (btnExport) {
      btnExport.addEventListener("click", () => {
        const payload = {
          version: 1,
          exportedAt: new Date().toISOString(),
          progress: loadProgress(),
          userDecks: userDecks
        };
        const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `nihongoshiken-flashcards-progress-${new Date().toISOString().slice(0, 10)}.json`;
        a.click();
        URL.revokeObjectURL(url);
      });
    }

    const btnImport = $("btn-import-progress");
    const inputImport = $("progress-import-file");
    if (btnImport && inputImport) {
      btnImport.addEventListener("click", () => inputImport.click());
      inputImport.addEventListener("change", (e) => {
        const file = e.target.files && e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => {
          try {
            const data = JSON.parse(reader.result);
            if (data.progress) saveProgress(data.progress);
            if (data.userDecks) {
              userDecks = data.userDecks;
              localStorage.setItem(USER_DECKS_KEY, JSON.stringify(userDecks));
            }
            alert("✅ Khôi phục tiến độ học Flashcard thành công!");
            updateGlobalStats();
            renderDecks();
          } catch (err) {
            alert("File không đúng định dạng JSON hợp lệ.");
          }
        };
        reader.readAsText(file);
      });
    }
  }

  // ========================================================
  // INITIALIZATION
  // ========================================================
  async function init() {
    await loadFlashcardCatalog();
    updateGlobalStats();
    renderDecks();
    setupEventListeners();

    const hash = location.hash.replace(/^#/, "");
    if (hash) {
      const match = getAllDecks().find(d => d.id === hash);
      if (match) window.openStudyPlayer(hash);
    }
  }

  document.addEventListener("DOMContentLoaded", init);
})();
