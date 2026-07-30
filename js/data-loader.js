const DataLoader = (() => {
  let catalogCache = null;
  const examCache = new Map();

  async function loadCatalog(force = false) {
    if (catalogCache && !force) return catalogCache;
    const res = await fetch("data/catalog.json", { cache: "no-cache" });
    if (!res.ok) {
      throw new Error(`Không tải được catalog.json (HTTP ${res.status})`);
    }
    catalogCache = await res.json();
    return catalogCache;
  }

  async function loadExam(examMeta) {
    const key = examMeta.id;
    if (examCache.has(key)) return examCache.get(key);
    const path = `data/${examMeta.file}`;
    const res = await fetch(path, { cache: "no-cache" });
    if (!res.ok) {
      throw new Error(`Không tải được đề ${examMeta.id} (HTTP ${res.status})`);
    }
    const exam = await res.json();
    examCache.set(key, exam);
    return exam;
  }

  function filterExams(catalog, { track, level, topic } = {}) {
    return (catalog.exams || []).filter((e) => {
      if (track && e.track !== track) return false;
      if (level && e.level !== level) return false;
      if (topic && e.topic !== topic) return false;
      return true;
    });
  }

  function groupByTrackThenTopic(exams) {
    const byTrack = new Map();
    for (const exam of exams) {
      const track = exam.track || "n3_review";
      if (!byTrack.has(track)) byTrack.set(track, new Map());
      const topicMap = byTrack.get(track);
      const topic = exam.topic || "grammar";
      if (!topicMap.has(topic)) topicMap.set(topic, []);
      topicMap.get(topic).push(exam);
    }
    return byTrack;
  }

  return {
    loadCatalog,
    loadExam,
    filterExams,
    groupByTrackThenTopic,
  };
})();
