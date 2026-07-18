(function () {
  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => Array.from(document.querySelectorAll(selector));
  const api = async (url, options) => {
    const response = await fetch(url, options);
    const type = response.headers.get("content-type") || "";
    const data = type.includes("application/json") ? await response.json() : { error: await response.text() };
    if (!response.ok) throw data;
    return data;
  };
  const text = (value) => String(value ?? "");
  const html = (value) => text(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[char]);
  const fileUrl = (path) => `/api/files?path=${encodeURIComponent(path)}`;
  const toast = (message) => {
    const box = $("#toast");
    if (!box) return;
    box.textContent = message;
    box.classList.add("show");
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => box.classList.remove("show"), 2600);
  };

  const store = {
    user: null,
    projects: [],
    activeProjectId: "",
    assets: [],
    scenes: [],
    stats: null,
    system: null,
    templates: [],
    history: [],
  };

  const activeProject = () => store.projects.find((project) => project.id === store.activeProjectId) || store.projects[0] || null;
  const videos = () => store.assets.filter((asset) => asset.type === "video");
  const audios = () => store.assets.filter((asset) => asset.type === "audio");
  const latestJob = () => activeProject()?.latestJob || null;

  async function refreshLiveData(projectId = store.activeProjectId) {
    const [me, projectsData, statsData] = await Promise.all([
      api("/api/me").catch(() => null),
      api("/api/projects").catch(() => ({ projects: [] })),
      api("/api/stats").catch(() => null),
    ]);
    store.user = me?.user || store.user;
    store.projects = projectsData.projects || [];
    store.stats = statsData;
    if (!store.activeProjectId && store.projects.length) store.activeProjectId = store.projects[0].id;
    if (projectId) store.activeProjectId = projectId;
    const project = activeProject();
    if (project) {
      const [assetsData, scenesData, historyData] = await Promise.all([
        api(`/api/projects/${project.id}/assets`).catch(() => ({ assets: [] })),
        api(`/api/projects/${project.id}/scenes`).catch(() => ({ scenes: [] })),
        api(`/api/projects/${project.id}/history`).catch(() => ({ history: [] })),
      ]);
      store.assets = assetsData.assets || [];
      store.scenes = scenesData.scenes || [];
      store.history = historyData.history || [];
    }
    store.system = await api("/api/system/status").catch(() => null);
    store.templates = (await api("/api/templates").catch(() => ({ templates: [] }))).templates || [];
    renderAllLiveScreens();
  }

  function setActiveProject(id) {
    if (!id) return;
    store.activeProjectId = id;
    refreshLiveData(id).catch((error) => toast(error.error || "Khong tai duoc du lieu du an."));
  }

  function projectPicker() {
    return `<select class="live-project-select">${store.projects.map((project) => `<option value="${html(project.id)}" ${project.id === store.activeProjectId ? "selected" : ""}>${html(project.title || "Untitled video")} - ${html(project.status)}</option>`).join("")}</select>`;
  }

  function mediaPreview(asset) {
    const url = fileUrl(asset.file_path);
    if (asset.type === "video") return `<video controls playsinline preload="metadata"><source src="${url}"></video>`;
    if (asset.type === "audio") return `<audio controls src="${url}"></audio>`;
    if (asset.type === "image") return `<img src="${url}" alt="">`;
    return `<div class="empty">Khong co preview</div>`;
  }

  function renderProjectExplorer() {
    const section = $("#project-explorer");
    const project = activeProject();
    if (!section) return;
    section.innerHTML = `
      <div class="page-head"><div><h2>Project Explorer</h2><p class="muted">Cay du lieu that cua project dang chon.</p></div><div class="top-actions">${projectPicker()}<button class="btn primary" data-page="timeline">Mo Edit video</button></div></div>
      <div class="grid dashboard-grid">
        <div class="panel"><div class="panel-head"><h3>${html(project?.title || "Chua co project")}</h3><span class="pill">${html(project?.status || "-")}</span></div>
          <div class="panel-body field-stack">
            <button class="btn" data-page="script">Scenes (${store.scenes.length})</button>
            <button class="btn" data-page="voice">Voice/Audio (${audios().length})</button>
            <button class="btn" data-page="media">Media (${store.assets.length})</button>
            <button class="btn" data-page="timeline">Edit timeline</button>
            <button class="btn" data-page="export">Xuat video</button>
          </div>
        </div>
        <div class="panel"><div class="panel-head"><h3>Chi tiet du an</h3></div><div class="panel-body field-stack">
          <div><label>Tieu de</label><input value="${html(project?.title || "")}" disabled></div>
          <div><label>De tai</label><textarea disabled>${html(project?.topic || "")}</textarea></div>
          <div class="empty" style="text-align:left;">Video: ${videos().length} file<br>Audio/Voice: ${audios().length} file<br>Scene: ${store.scenes.length}<br>Job: ${html(latestJob()?.status || "chua co")}</div>
        </div></div>
      </div>`;
  }

  function renderAssetWarehouse() {
    const section = $("#assets");
    if (!section) return;
    const rows = store.assets.map((asset) => `
      <div class="panel live-asset-card" data-id="${html(asset.id)}">
        <div class="live-media">${mediaPreview(asset)}</div>
        <div class="panel-body field-stack">
          <strong>${html(asset.file_name)}</strong>
          <p class="tiny">${html(asset.type)} - ${Math.round((asset.file_size || 0) / 1024)} KB</p>
          <div class="top-actions"><button class="btn use-live-asset" data-type="${html(asset.type)}" data-id="${html(asset.id)}">Dung trong Edit</button><a class="btn" href="${fileUrl(asset.file_path)}" target="_blank" download>Tai/Mo</a><button class="btn delete-live-asset" data-id="${html(asset.id)}">Xoa cache</button></div>
        </div>
      </div>`).join("");
    section.innerHTML = `
      <div class="page-head"><div><h2>Kho tai nguyen</h2><p class="muted">Tat ca file that da upload vao project, gom MP4, MP3, image, logo, SFX.</p></div><div class="top-actions">${projectPicker()}<button class="btn primary live-upload-video">+ Upload file</button></div></div>
      <div class="grid dashboard-grid">
        <div class="panel"><div class="panel-head"><h3>Bo loc</h3></div><div class="panel-body field-stack"><button class="btn">Tat ca (${store.assets.length})</button><button class="btn">Video (${videos().length})</button><button class="btn">Audio (${audios().length})</button></div></div>
        <div class="grid output-grid">${rows || '<div class="empty">Chua co file trong project. Bam Upload file de chon file tu may.</div>'}</div>
      </div>`;
  }

  function renderEditor() {
    const shell = $("#timeline .editor-shell");
    const timeline = $("#timeline .timeline-v3");
    const video = videos()[0];
    const project = activeProject();
    $("#timeline .page-head h2") && ($("#timeline .page-head h2").textContent = "Edit video");
    $$('[data-page="timeline"]').forEach((button) => {
      if (button.textContent.includes("Timeline")) button.textContent = "Edit video";
    });
    if (shell) {
      const preview = shell.querySelector(".editor-preview-canvas") || shell.querySelector(".preview-frame");
      if (preview) {
        preview.innerHTML = video
          ? `<video controls playsinline preload="metadata" style="width:100%;height:100%;object-fit:contain;background:#000;border-radius:8px;"><source src="${fileUrl(video.file_path)}"></video>`
          : `<div style="z-index:2;text-align:center;display:grid;gap:12px;place-items:center;"><button class="btn primary live-upload-video">+ Them video MP4</button><p class="tiny">Chua co video trong project. Chon MP4 tu may hoac tu Thu vien Media.</p></div>`;
      }
      const assetBox = shell.querySelector(".editor-assets");
      if (assetBox) {
        assetBox.innerHTML = store.assets.slice(0, 12).map((asset) => `<button class="editor-asset use-live-asset" data-id="${html(asset.id)}" data-type="${html(asset.type)}"><strong>${html(asset.file_name)}</strong><span class="tiny">${html(asset.type)}</span></button>`).join("") || '<div class="empty">Chua co media that.</div>';
      }
    }
    if (timeline) {
      const clip = (asset, cls, left, width) => `<button class="clip-v3 ${cls} use-live-asset" data-id="${html(asset.id)}" data-type="${html(asset.type)}" style="left:${left}px;width:${width}px;">${html(asset.file_name)}</button>`;
      const voiceClips = audios().map((asset, index) => clip(asset, "voice", 20 + index * 260, 420)).join("");
      const videoClips = videos().map((asset, index) => clip(asset, "video", 20 + index * 280, 260)).join("");
      const subtitleText = store.scenes.length ? store.scenes.map((scene, index) => `<span class="clip-v3 subtitle" style="left:${20 + index * 150}px;width:135px;">S${index + 1}</span>`).join("") : "";
      timeline.innerHTML = `<div class="timeline-inner">
        <div class="timeline-tools-v3"><button class="btn live-upload-video">+ Add video MP4</button><button class="btn live-upload-audio">+ Add voice/MP3</button><button class="btn live-create-sfx" data-preset="whoosh">+ SFX</button><label class="pill"><input id="liveSubtitleToggle" type="checkbox" checked> Phu de</label><button class="btn" id="liveDeleteClip">Delete clip chon</button><span class="pill">${html(project?.title || "Chua chon du an")}</span></div>
        <div class="time-ruler-v3"><strong>Track / Time</strong><span>00:00</span><span>00:10</span><span>00:20</span><span>00:30</span><span>00:40</span><span>00:50</span><span>01:00</span></div>
        <div class="timeline-track-v3"><div class="track-label-v3"><strong>Video</strong></div><div class="track-lane-v3">${videoClips || '<button class="btn live-upload-video">+ Add video MP4</button>'}</div></div>
        <div class="timeline-track-v3"><div class="track-label-v3"><strong>Voice / Audio</strong></div><div class="track-lane-v3">${voiceClips || '<button class="btn live-upload-audio">+ Tao/Add MP3</button>'}</div></div>
        <div class="timeline-track-v3"><div class="track-label-v3"><strong>Subtitle</strong></div><div class="track-lane-v3">${subtitleText || '<span class="tiny">Chua co scene de sinh subtitle</span>'}</div></div>
        <div class="timeline-track-v3"><div class="track-label-v3"><strong>Effect / SFX</strong></div><div class="track-lane-v3"><button class="clip-v3 transition live-create-sfx" data-preset="whoosh" style="left:30px;width:180px;">Whoosh transition</button></div></div>
      </div>`;
    }
  }

  function renderJobs() {
    const section = $("#jobs");
    if (!section) return;
    const rows = store.projects.map((project) => project.latestJob ? { project, job: project.latestJob } : null).filter(Boolean);
    section.innerHTML = `<div class="page-head"><div><h2>Hang doi xu ly</h2><p class="muted">Voice MP3, render MP4 va tien trinh that tu backend.</p></div><button class="btn live-refresh">Lam moi</button></div>
      <div class="panel"><div class="panel-head"><h3>Jobs</h3><span class="pill">${rows.length} job</span></div><div class="panel-body field-stack">
      ${rows.map(({ project, job }) => `<div class="job-row"><div><strong>${html(project.title)}</strong><p class="tiny">${html(job.current_step)} ${html(job.error_message || "")}</p></div><div class="bar"><span style="width:${Number(job.progress || 0)}%;"></span></div><span class="pill">${html(job.status)} ${Number(job.progress || 0)}%</span><button class="btn live-open-project" data-id="${html(project.id)}">Mo</button></div>`).join("") || '<div class="empty">Chua co job nao.</div>'}
      </div></div>`;
  }

  function renderOutputs() {
    const section = $("#outputs");
    if (!section) return;
    const rows = store.projects.filter((project) => project.latestJob?.video_path || project.output_path);
    section.innerHTML = `<div class="page-head"><div><h2>Video da xuat</h2><p class="muted">Chi hien file MP4/MP3 that da render xong.</p></div><button class="btn live-refresh">Lam moi</button></div>
      <div class="grid output-grid">${rows.map((project) => {
        const job = project.latestJob || {};
        const videoPath = job.video_path || project.output_path;
        return `<div class="panel"><div class="panel-body field-stack"><strong>${html(project.title)}</strong><p class="tiny">${html(job.finished_at || project.updated_at)}</p>${videoPath ? `<video controls playsinline preload="metadata" src="${fileUrl(videoPath)}"></video>` : ""}<div class="top-actions"><a class="btn primary" href="${fileUrl(videoPath)}" target="_blank" download>Xem/Tai MP4</a>${job.audio_path ? `<a class="btn" href="${fileUrl(job.audio_path)}" target="_blank" download>Tai MP3</a>` : ""}</div></div></div>`;
      }).join("") || '<div class="empty">Chua co video xuat thanh cong.</div>'}</div>`;
  }

  function renderAiSettings() {
    const section = $("#ai-settings");
    if (!section) return;
    const s = store.system || {};
    section.innerHTML = `<div class="page-head"><div><h2>Cai dat AI va API</h2><p class="muted">Kiem tra ket noi that, khong hien secret.</p></div><button class="btn live-refresh">Test lai</button></div>
      <div class="grid dashboard-grid">
        ${[
          ["Google OAuth", s.googleConfigured],
          ["Private Gmail allowlist", s.privateAccessEnabled],
          ["Gemini API", s.geminiConfigured],
          ["Cloudflare R2", s.r2Configured],
          ["Neon/Postgres", s.databaseConfigured],
          [`FFmpeg: ${html(s.ffmpegBin || "-")}`, true],
          [`TTS provider: ${html(s.ttsProvider || "edge")}`, true],
        ].map(([name, ok]) => `<div class="card"><span class="muted">${name}</span><strong>${ok ? "OK" : "Chua cau hinh"}</strong><span class="trend">${ok ? "San sang" : "Can them env tren Render"}</span></div>`).join("")}
      </div>`;
  }

  function renderHistory() {
    const section = $("#history");
    if (!section) return;
    section.innerHTML = `<div class="page-head"><div><h2>Lich su chinh sua</h2><p class="muted">Lay tu project, scene, asset va job that.</p></div><button class="btn live-refresh">Lam moi</button></div>
      <div class="panel"><div class="panel-body field-stack">${store.history.map((item, index) => `<div class="history-row"><div class="history-dot">${index + 1}</div><div><strong>${html(item.label)}</strong><p class="tiny">${html(item.at)} - ${html(item.detail)}</p></div></div>`).join("") || '<div class="empty">Chua co lich su.</div>'}</div></div>`;
  }

  function renderAccount() {
    const section = $("#account");
    if (!section) return;
    const storage = store.stats?.storage || {};
    section.innerHTML = `<div class="page-head"><div><h2>Tai khoan va dung luong</h2><p class="muted">Du lieu rieng theo Gmail dang dang nhap.</p></div><button class="btn" id="liveLogout">Dang xuat</button></div>
      <div class="grid dashboard-grid">
        <div class="panel"><div class="panel-head"><h3>Ho so</h3><span class="pill ok">Da xac thuc</span></div><div class="panel-body field-stack"><div><label>Email</label><input value="${html(store.user?.email || "")}" disabled></div><div><label>Ten</label><input value="${html(store.user?.name || "")}" disabled></div></div></div>
        <div class="panel"><div class="panel-head"><h3>Dung luong server/R2 cache</h3></div><div class="panel-body field-stack"><div class="bar"><span style="width:${Number(storage.percent || 0)}%;"></span></div><p class="tiny">${html(storage.usedHuman || "0 B")} / ${html(storage.quotaHuman || "-")}</p><p class="tiny">Ban xuat final nen tai ve may, R2 chi dung cho file nhap/cache nhap.</p></div></div>
      </div>`;
  }

  function renderTemplates() {
    const section = $("#templates");
    if (!section) return;
    section.innerHTML = `<div class="page-head"><div><h2>Template video</h2><p class="muted">Ap dung cau truc mau vao project dang chon, sau do regenerate kich ban.</p></div>${projectPicker()}</div>
      <div class="grid screen-cards">${store.templates.map((tpl, index) => `<div class="panel template-card"><div class="template-cover" style="--art:linear-gradient(135deg,${index % 2 ? "#0f766e,#1e293b" : "#7c3aed,#db2777"});"><h3>${html(tpl.name)}</h3></div><div class="panel-body"><p class="tiny">${html(tpl.description)}</p><button class="btn primary live-apply-template" data-id="${html(tpl.id)}" style="width:100%;margin-top:12px;">Dung mau nay</button></div></div>`).join("")}</div>`;
  }

  function renderMusic() {
    const section = $("#music");
    if (!section) return;
    section.innerHTML = `<div class="page-head"><div><h2>Kho MP3/SFX</h2><p class="muted">Audio that trong project va nut tao am thanh phu bang FFmpeg.</p></div><div class="top-actions"><button class="btn live-upload-audio">+ Upload MP3</button><button class="btn primary live-create-sfx" data-preset="whoosh">+ Tao SFX</button></div></div>
      <div class="grid output-grid">${audios().map((asset) => `<div class="panel"><div class="panel-body field-stack"><strong>${html(asset.file_name)}</strong><audio controls src="${fileUrl(asset.file_path)}"></audio><a class="btn" href="${fileUrl(asset.file_path)}" download>Tai MP3</a></div></div>`).join("") || '<div class="empty">Chua co MP3/audio trong project.</div>'}</div>`;
  }

  function renderAllLiveScreens() {
    renderProjectExplorer();
    renderAssetWarehouse();
    renderEditor();
    renderJobs();
    renderOutputs();
    renderAiSettings();
    renderHistory();
    renderAccount();
    renderTemplates();
    renderMusic();
  }

  async function deleteAsset(assetId) {
    await api(`/api/assets/${assetId}`, { method: "DELETE" });
    await refreshLiveData();
    toast("Da xoa file cache/tam khoi project.");
  }

  async function createSfx(preset) {
    const project = activeProject();
    if (!project) return toast("Hay tao/chon project truoc.");
    await api(`/api/projects/${project.id}/sfx`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ preset }),
    });
    await refreshLiveData(project.id);
    toast("Da tao SFX MP3 va them vao Voice/Audio track.");
  }

  document.addEventListener("click", (event) => {
    const target = event.target.closest("button, a");
    if (!target) return;
    if (target.dataset.page && typeof window.switchPage === "function") {
      window.switchPage(target.dataset.page);
    }
    if (target.classList.contains("live-refresh")) refreshLiveData().catch((error) => toast(error.error || "Lam moi loi."));
    if (target.classList.contains("live-open-project")) setActiveProject(target.dataset.id);
    if (target.classList.contains("live-upload-video")) {
      const input = $("#assetFile");
      if (input) {
        input.accept = "video/*";
        input.click();
        toast("Chon MP4 tu may. Web online se upload qua R2 de backend render.");
      }
    }
    if (target.classList.contains("live-upload-audio")) {
      const input = $("#assetFile");
      if (input) {
        input.accept = "audio/*";
        input.click();
        toast("Chon MP3/WAV tu may de them vao Audio track.");
      }
    }
    if (target.classList.contains("delete-live-asset")) deleteAsset(target.dataset.id).catch((error) => toast(error.error || "Xoa file loi."));
    if (target.classList.contains("use-live-asset")) {
      $$(".clip-v3.selected, .editor-asset.selected").forEach((el) => el.classList.remove("selected"));
      target.classList.add("selected");
      toast(target.dataset.type === "video" ? "Da chon video cho Program Preview/Edit." : "Da chon audio/voice cho Audio Track.");
    }
    if (target.classList.contains("live-create-sfx")) createSfx(target.dataset.preset || "whoosh").catch((error) => toast(error.error || "Tao SFX loi."));
    if (target.classList.contains("live-apply-template")) {
      const project = activeProject();
      if (!project) return toast("Hay tao/chon project truoc.");
      api(`/api/projects/${project.id}/apply-template`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ templateId: target.dataset.id }),
      }).then(() => refreshLiveData(project.id)).then(() => toast("Da ap dung template vao project. Bam Regenerate de tao lai kich ban.")).catch((error) => toast(error.error || "Ap template loi."));
    }
    if (target.id === "liveDeleteClip") {
      const selected = $(".clip-v3.selected");
      if (!selected?.dataset.id) return toast("Hay chon clip media tren timeline truoc.");
      deleteAsset(selected.dataset.id).catch((error) => toast(error.error || "Xoa clip loi."));
    }
    if (target.id === "liveLogout") $("#logoutButton")?.click();
  });

  document.addEventListener("change", (event) => {
    const select = event.target.closest(".live-project-select");
    if (select) setActiveProject(select.value);
  });

  const boot = () => {
    if (location.protocol === "file:") return;
    refreshLiveData().catch(() => null);
    setInterval(() => refreshLiveData().catch(() => null), 8000);
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
