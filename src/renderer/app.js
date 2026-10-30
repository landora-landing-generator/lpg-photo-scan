"use strict";

const $ = (id) => document.getElementById(id);
const ipc = window.api;

const VERDICT = {
  people: "Есть люди",
  unsure: "Проверить глазами",
  clean: "Людей нет",
  error: "Сайт не открылся",
  none: "Не проверен",
};

const state = {
  hosts: [], // [{ host, label }] in list order; host is punycode, label is for people
  results: {}, // host → result
  filter: null, // verdict shown, null = all
  open: new Set(), // expanded rows
  working: new Map(), // host → current step
  total: 0,
  doneNow: 0,
  redrawSite: null, // { host, done, total } while a site-wide redraw runs
};

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") node.className = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children) if (c != null && c !== false) node.append(c);
  return node;
}

function setStatus(id, text, kind = "") {
  $(id).textContent = text;
  $(id).className = `status ${kind}`;
}

function plural(n, one, few, many) {
  const m10 = n % 10;
  const m100 = n % 100;
  const word = m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? few : many;
  return `${n} ${word}`;
}

const kb = (bytes) => (bytes >= 1024 * 1024 ? `${(bytes / 1048576).toFixed(1)} МБ` : `${Math.max(1, Math.round(bytes / 1024))} КБ`);
const labelOf = (host) => state.hosts.find((h) => h.host === host)?.label ?? host;
const verdictOf = (host) => state.results[host]?.verdict ?? "none";
const imagesOf = (r) => [...(r?.people ?? []), ...(r?.unsure ?? [])];

// ---------- key: one service, one key ----------

const keys = { providers: [], settings: null, defaultRules: "" };
const providerById = (id) => keys.providers.find((p) => p.id === id);

function renderProvider() {
  const p = providerById($("provider").value);
  if (!p) return;
  $("key-hint").textContent = `Где взять: ${p.hint}. Цена: ${p.scanCost}, новый кадр ${p.drawCost}.`;
  // Fields show the model in force: the service's default unless the user typed another.
  const prev = providerById(keys.shown);
  const fillModel = (id, def, prevDef) => {
    const v = $(id).value.trim();
    if (!v || v === prevDef) $(id).value = def ?? "";
  };
  fillModel("recognize-model", p.visionModel, prev?.visionModel);
  renderDrawModels();
  keys.shown = p.id;
}

/**
 * Drawing model fields in the viewer and the studio: one shared, remembered
 * value. The service's models are suggestions; any model name can be typed.
 */
function renderDrawModels() {
  const p = providerById($("provider").value);
  if (!p) return;
  $("draw-models").replaceChildren(...p.drawModels.map((m) => el("option", { value: m.id }, m.label)));
  const own = p.id === keys.savedProvider ? keys.settings.models.draw : "";
  const current = own || p.drawModel;
  for (const id of ["viewer-model", "studio-model"]) {
    if (document.activeElement !== $(id)) $(id).value = current;
    $(id).placeholder = p.drawModel;
  }
}

function commitDrawModel(id) {
  const p = providerById($("provider").value);
  const typed = $(id).value.trim();
  // Empty or the default means "the service's default", so updates can move it.
  const model = !typed || typed === p.drawModel ? "" : typed;
  if (model === keys.settings.models.draw) return;
  keys.settings.models.draw = model;
  ipc.setDrawModel(model);
  renderDrawModels();
}

for (const id of ["viewer-model", "studio-model"]) {
  $(id).addEventListener("change", () => commitDrawModel(id));
  $(id).addEventListener("keydown", (e) => {
    if (e.key === "Enter") $(id).blur();
  });
  // A click shows every suggestion, not only the ones matching the current text.
  $(id).addEventListener("focus", () => $(id).select());
}

/** Folded card title: which service, and whether its key works. */
function renderKeySummary(ok) {
  const p = providerById($("provider").value);
  const has = $("key").value.trim() !== "";
  $("key-summary").textContent = has ? `${p.label}${ok === false ? " — ключ не принят" : ok ? " ✓" : ""}` : "не задан";
  $("key-summary").className = `fold-note${ok ? " ok" : ""}`;
}

$("provider").addEventListener("change", () => {
  // Each service remembers its own key, so switching back loses nothing.
  $("key").value = keys.settings.keys[$("provider").value] ?? "";
  setStatus("key-status", "");
  renderProvider();
  renderKeySummary();
});

$("key-toggle").addEventListener("click", () => {
  const show = $("key").type === "password";
  $("key").type = show ? "text" : "password";
  $("key-toggle").textContent = show ? "Скрыть" : "Показать";
});

$("rules-reset").addEventListener("click", () => {
  $("redraw-rules").value = keys.defaultRules;
});

$("key-save").addEventListener("click", async () => {
  const provider = $("provider").value;
  const key = $("key").value.trim();
  setStatus("key-status", "Проверяю ключ…");
  const rules = $("redraw-rules").value.trim();
  const res = await ipc.saveSettings({
    provider,
    key,
    // A default model is stored as "default", so a later app update can move it.
    models: {
      recognize: $("recognize-model").value.trim() === providerById(provider).visionModel ? "" : $("recognize-model").value,
      draw: provider === keys.savedProvider ? keys.settings.models.draw : "",
    },
    // The default text is stored as "use the default", so it follows app updates.
    redrawRules: rules === keys.defaultRules ? "" : rules,
  });
  if (res.error) {
    setStatus("key-status", res.error, "bad");
    return;
  }
  keys.settings.keys[provider] = key;
  if (provider !== keys.savedProvider) keys.settings.models.draw = "";
  keys.savedProvider = provider;
  renderDrawModels();
  setStatus("key-status", res.ok ? `Ключ ${res.message}.` : `Ключ ${res.message}.`, res.ok ? "ok" : "bad");
  renderKeySummary(res.ok);
  if (res.ok) setTimeout(() => ($("key-card").open = false), 900);
});

// ---------- domains ----------

let parseTimer;
$("domains").addEventListener("input", () => {
  clearTimeout(parseTimer);
  parseTimer = setTimeout(refreshDomains, 250);
});

async function refreshDomains() {
  state.hosts = await ipc.parseDomains($("domains").value);
  $("domains-count").textContent = plural(state.hosts.length, "домен", "домена", "доменов");
  render();
}

/** Adds imported domains under the ones already in the field. */
async function addImported(res) {
  if (res.error) {
    setStatus("scan-status", res.error, "bad");
    return;
  }
  if (!res.domains?.length) return;
  const before = state.hosts.length;
  const current = $("domains").value.trim();
  $("domains").value = (current ? `${current}\n` : "") + res.domains.join("\n");
  await refreshDomains();
  setStatus("scan-status", `Добавлено доменов: ${state.hosts.length - before}.`, "ok");
}

$("domains-import").addEventListener("click", async () => addImported(await ipc.importDomains()));

const domainsBox = $("domains");
domainsBox.addEventListener("dragover", (e) => {
  if (e.dataTransfer?.types.includes("Files")) {
    e.preventDefault();
    domainsBox.classList.add("drop");
  }
});
domainsBox.addEventListener("dragleave", () => domainsBox.classList.remove("drop"));
domainsBox.addEventListener("drop", async (e) => {
  if (!e.dataTransfer?.files?.length) return;
  e.preventDefault();
  domainsBox.classList.remove("drop");
  addImported(await ipc.importDroppedFiles(e.dataTransfer.files));
});
// A file dropped anywhere else must not navigate the window away.
document.addEventListener("dragover", (e) => e.preventDefault());
document.addEventListener("drop", (e) => e.preventDefault());

// ---------- scan ----------

async function start(again) {
  setStatus("scan-status", "");
  await refreshDomains();
  const res = await ipc.startScan($("domains").value, again);
  if (res?.error) setStatus("scan-status", res.error, "bad");
}

$("scan-start").addEventListener("click", () => start(false));
$("scan-again").addEventListener("click", () => {
  if (confirm("Проверить весь список заново? Это снова потратит деньги на ключе.")) start(true);
});
$("scan-stop").addEventListener("click", () => {
  $("scan-stop").disabled = true;
  $("scan-stop").textContent = "Останавливаю…";
  ipc.stopScan();
});

function setRunning(on) {
  $("scan-start").hidden = on;
  $("scan-again").hidden = on;
  $("domains-import").disabled = on;
  $("scan-stop").hidden = !on;
  $("scan-stop").disabled = false;
  $("scan-stop").textContent = "Остановить";
  $("progress").hidden = !on;
  $("domains").readOnly = on;
  $("clear").disabled = on;
}

function renderProgress() {
  const pct = state.total ? Math.round((state.doneNow / state.total) * 100) : 0;
  $("progress-fill").style.width = `${pct}%`;
  $("progress-text").textContent = `Проверено ${state.doneNow} из ${state.total}`;
  $("progress-sites").replaceChildren(...[...state.working].map(([host, step]) => el("li", {}, `${labelOf(host)} — ${step}`)));
}

ipc.onBegin(({ total }) => {
  state.total = total;
  state.doneNow = 0;
  state.working.clear();
  setRunning(true);
  renderProgress();
});
ipc.onProgress(({ host, step }) => {
  state.working.set(host, step);
  renderProgress();
});
ipc.onSite((result) => {
  state.results[result.host] = result;
  state.working.delete(result.host);
  state.doneNow++;
  renderProgress();
  render();
});
ipc.onEnd(({ stopped, fatal }) => {
  setRunning(false);
  if (fatal) {
    setStatus("scan-status", `Проверка остановлена: ${fatal}`, "bad");
    $("key-card").open = true;
  }
  else if (stopped) setStatus("scan-status", `Остановлено на ${state.doneNow} из ${state.total}. Остальные проверятся при следующем нажатии.`);
  else setStatus("scan-status", `Готово: проверено сайтов — ${state.doneNow}.`, "ok");
});

// ---------- results ----------

$("clear").addEventListener("click", async () => {
  if (!confirm("Стереть результаты проверки? Список доменов останется.")) return;
  await ipc.clearResults();
  state.results = {};
  state.open.clear();
  render();
});

$("excel").addEventListener("click", async () => {
  const res = await ipc.saveExcel();
  if (res.error) setStatus("scan-status", res.error, "bad");
  else if (res.saved) setStatus("scan-status", `Сохранено: ${res.filePath}`, "ok");
});

ipc.onImageUpdated(({ host, image }) => {
  const r = state.results[host];
  if (!r) return;
  for (const list of [r.people, r.unsure]) {
    const i = list.findIndex((x) => x.id === image.id);
    if (i >= 0) list[i] = image;
  }
  render();
});

ipc.onRedrawProgress((p) => {
  state.redrawSite = p.finished ? null : p;
  render();
});

function renderChips() {
  const counts = { people: 0, unsure: 0, clean: 0, error: 0, none: 0 };
  for (const { host } of state.hosts) counts[verdictOf(host)]++;
  $("chips").replaceChildren(
    ...Object.entries(counts)
      .filter(([, n]) => n > 0)
      .map(([v, n]) =>
        el(
          "button",
          {
            class: `chip ${v}${state.filter === v ? " active" : ""}`,
            title: state.filter === v ? "Показать все" : "Показать только эти",
            onclick: () => {
              state.filter = state.filter === v ? null : v;
              render();
            },
          },
          `${VERDICT[v]}: ${n}`,
        ),
      ),
  );
}

function siteActions(host, r) {
  const drawn = imagesOf(r).filter((img) => img.redraw).length;
  const left = r.people.filter((img) => !img.redraw).length;
  const busy = state.redrawSite;
  const mine = busy?.host === host;
  return el(
    "div",
    { class: "site-actions" },
    mine
      ? el("button", { class: "danger", onclick: () => ipc.stopRedrawSite() }, `Остановить (готово ${busy.done} из ${busy.total})`)
      : left > 0 &&
          el(
            "button",
            {
              class: "primary",
              disabled: Boolean(busy),
              onclick: async () => {
                const res = await ipc.redrawSite(host);
                if (res.error) alert(res.error);
                else if (res.errors?.length) alert(`Не получилось ${res.errors.length} кадр(ов):\n${res.errors.slice(0, 3).join("\n")}`);
              },
            },
            `Перерисовать все кадры с людьми (${left})`,
          ),
    drawn > 0 &&
      el(
        "button",
        {
          onclick: async () => {
            const res = await ipc.saveSite(host);
            if (res.error) alert(res.error);
          },
        },
        `Скачать новые кадры в папку (${drawn})`,
      ),
  );
}

function thumbGrid(host, r) {
  const grid = el("div", { class: "thumbs" });
  for (const [list, label] of [
    [r.people, "Кадры с людьми"],
    [r.unsure, "Нейросеть не уверена — посмотрите сами"],
  ]) {
    if (!list.length) continue;
    grid.append(el("div", { class: "label" }, `${label} (${list.length})`));
    for (const img of list) {
      let pagePath = img.page;
      try {
        pagePath = decodeURI(new URL(img.page).pathname);
      } catch {
        /* keep as is */
      }
      grid.append(
        el(
          "figure",
          {},
          img.redraw && el("span", { class: "badge" }, "✓ новый"),
          el("img", { src: img.thumb, alt: "", title: "Открыть: посмотреть, перерисовать, скачать", onclick: () => openViewer(host, img.id) }),
          el("figcaption", {}, `стр. ${pagePath}`),
        ),
      );
    }
  }
  return el("div", {}, siteActions(host, r), grid);
}

function render() {
  renderChips();
  const rows = [];
  for (const { host, label } of state.hosts) {
    const v = verdictOf(host);
    if (state.filter && state.filter !== v) continue;
    const r = state.results[host];
    const expandable = r && imagesOf(r).length > 0;
    const isOpen = expandable && state.open.has(host);
    const note = r?.error ?? (r?.unchecked ? `не проверено кадров: ${r.unchecked}` : null);
    rows.push(
      el(
        "tr",
        {
          class: `site${isOpen ? " open" : ""}`,
          title: expandable ? "Нажмите, чтобы увидеть кадры" : null,
          onclick: () => {
            if (!expandable) return;
            state.open.has(host) ? state.open.delete(host) : state.open.add(host);
            render();
          },
        },
        el(
          "td",
          {},
          el("span", { class: "caret" }, expandable ? (isOpen ? "▾" : "▸") : ""),
          el("span", { class: "site-name" }, label),
          note ? el("div", { class: "note" }, note) : null,
        ),
        el("td", {}, el("span", { class: `tag ${v}` }, VERDICT[v])),
        el("td", { class: "n" }, r && !r.error ? String(r.people.length) : ""),
        el("td", { class: "n" }, r && !r.error ? String(r.unsure.length) : ""),
        el("td", { class: "n" }, r ? String(imagesOf(r).filter((i) => i.redraw).length || "") : ""),
        el("td", { class: "n" }, r && !r.error ? String(r.images) : ""),
      ),
    );
    if (isOpen) rows.push(el("tr", { class: "details" }, el("td", { colspan: "6" }, thumbGrid(host, r))));
  }
  $("rows").replaceChildren(...rows);
  $("empty").hidden = rows.length > 0;
  $("empty").textContent = state.hosts.length ? "Нет сайтов с таким итогом." : "Пока ничего не проверено.";
}

// ---------- viewer: look, redraw, download ----------

const viewer = { host: null, id: null, busy: false };

function viewerList() {
  return imagesOf(state.results[viewer.host]);
}

function currentImage() {
  return viewerList().find((img) => img.id === viewer.id);
}

async function openViewer(host, id) {
  viewer.host = host;
  viewer.id = id;
  $("viewer").hidden = false;
  await showViewerImage();
}

async function showViewerImage() {
  const img = currentImage();
  if (!img) return;
  const list = viewerList();
  const pos = list.findIndex((x) => x.id === img.id);
  $("viewer-title").textContent = labelOf(viewer.host);
  $("viewer-pos").textContent = `${pos + 1} из ${list.length}`;
  $("viewer-prev").disabled = pos <= 0;
  $("viewer-next").disabled = pos >= list.length - 1;
  $("viewer-page").textContent = img.page;
  $("viewer-page").onclick = () => ipc.openExternal(img.page);
  $("viewer-old-meta").textContent = img.width ? `· ${img.width}×${img.height}, ${kb(img.bytes)}` : "";
  $("viewer-prompt").value = img.redraw?.prompt ?? "";
  setStatus("viewer-status", "");

  // Thumbnail first, the full-size original as soon as it arrives.
  $("viewer-old").src = img.thumb;
  $("viewer-old-wait").hidden = true;
  const id = img.id;
  ipc.originalImage(viewer.host, id).then((res) => {
    if (viewer.id !== id) return;
    if (typeof res === "string") $("viewer-old").src = res;
  });
  await showRedrawn(img);
}

async function showRedrawn(img) {
  const preview = img.redraw ? await ipc.redrawnImage(viewer.host, img.id) : null;
  if (preview) {
    $("viewer-new").src = preview;
    $("viewer-new-wait").hidden = true;
    $("viewer-new-meta").textContent = `· ${img.redraw.width}×${img.redraw.height}, ${kb(img.redraw.bytes)}, JPEG для сайта`;
  } else {
    $("viewer-new").removeAttribute("src");
    $("viewer-new-wait").hidden = false;
    $("viewer-new-wait").textContent = "Ещё не перерисован — нажмите «Перерисовать».";
    $("viewer-new-meta").textContent = "";
  }
  $("viewer-redraw").textContent = img.redraw ? "Перерисовать ещё раз" : "Перерисовать";
  $("viewer-save").disabled = !img.redraw;
}

function step(delta) {
  if (viewer.busy) return;
  const list = viewerList();
  const pos = list.findIndex((x) => x.id === viewer.id) + delta;
  if (pos < 0 || pos >= list.length) return;
  viewer.id = list[pos].id;
  showViewerImage();
}

function closeViewer() {
  // Closing never waits: a drawing in progress is cancelled.
  if (viewer.busy) ipc.cancelRedraw();
  $("viewer").hidden = true;
}

$("viewer-prev").addEventListener("click", () => step(-1));
$("viewer-next").addEventListener("click", () => step(1));
$("viewer-close").addEventListener("click", closeViewer);
$("viewer").addEventListener("click", (e) => {
  if (e.target === $("viewer")) closeViewer();
});

function setViewerBusy(on) {
  viewer.busy = on;
  $("viewer-redraw").textContent = on ? "Отменить" : currentImage()?.redraw ? "Перерисовать ещё раз" : "Перерисовать";
  $("viewer-redraw").classList.toggle("primary", !on);
  $("viewer-redraw").classList.toggle("danger", on);
  $("viewer-prev").disabled = on || $("viewer-prev").disabled;
  $("viewer-next").disabled = on || $("viewer-next").disabled;
}

$("viewer-redraw").addEventListener("click", async () => {
  if (viewer.busy) {
    ipc.cancelRedraw();
    return;
  }
  const img = currentImage();
  if (!img) return;
  const id = img.id;
  setViewerBusy(true);
  $("viewer-save").disabled = true;
  $("viewer-new-wait").hidden = false;
  $("viewer-new-wait").textContent = "Рисую новый кадр… обычно 20–60 секунд. Можно отменить или закрыть окно.";
  $("viewer-new").removeAttribute("src");
  setStatus("viewer-status", "");
  const res = await ipc.redrawImage(viewer.host, id, $("viewer-prompt").value);
  setViewerBusy(false);
  if (viewer.id !== id || $("viewer").hidden) return; // the user moved on
  if (res.error) {
    setStatus("viewer-status", res.error, res.cancelled ? "" : "bad");
    await showRedrawn(currentImage());
    return;
  }
  $("viewer-prompt").value = res.image.redraw.prompt;
  await showRedrawn(res.image);
  setStatus("viewer-status", "Готово. Не нравится — поправьте описание и перерисуйте.", "ok");
});

$("viewer-save").addEventListener("click", async () => {
  const res = await ipc.saveImage(viewer.host, viewer.id);
  if (res.error) setStatus("viewer-status", res.error, "bad");
  else if (res.saved) setStatus("viewer-status", `Сохранено: ${res.filePath}`, "ok");
});

// ---------- studio: own picture as a reference, or words only ----------

const studio = { refId: null, file: null, busy: false };

function setReference(res) {
  if (!res || res.canceled) return;
  if (res.error) {
    setStatus("studio-status", res.error, "bad");
    return;
  }
  studio.refId = res.id;
  $("studio-ref").src = res.preview;
  $("studio-drop-text").hidden = true;
  $("studio-clear").hidden = false;
  $("studio-aspect").disabled = true;
  $("studio-aspect").title = "Размер — как у образца";
  setStatus("studio-status", `Образец ${res.width}×${res.height}. Новый кадр будет того же размера.`);
}

$("studio-drop").addEventListener("click", async () => setReference(await ipc.studioReference()));
$("studio-drop").addEventListener("keydown", async (e) => {
  if (e.key === "Enter" || e.key === " ") setReference(await ipc.studioReference());
});
$("studio-drop").addEventListener("dragover", (e) => {
  e.preventDefault();
  $("studio-drop").classList.add("drop");
});
$("studio-drop").addEventListener("dragleave", () => $("studio-drop").classList.remove("drop"));
$("studio-drop").addEventListener("drop", async (e) => {
  e.preventDefault();
  $("studio-drop").classList.remove("drop");
  const file = e.dataTransfer?.files?.[0];
  if (file) setReference(await ipc.studioDroppedReference(file));
});
$("studio-clear").addEventListener("click", () => {
  studio.refId = null;
  $("studio-ref").removeAttribute("src");
  $("studio-drop-text").hidden = false;
  $("studio-clear").hidden = true;
  $("studio-aspect").disabled = false;
  $("studio-aspect").title = "";
  setStatus("studio-status", "");
});

function setStudioBusy(on) {
  studio.busy = on;
  $("studio-go").textContent = on ? "Отменить" : studio.file ? "Нарисовать ещё" : "Нарисовать";
  $("studio-go").classList.toggle("primary", !on);
  $("studio-go").classList.toggle("danger", on);
}

$("studio-go").addEventListener("click", async () => {
  if (studio.busy) {
    ipc.studioCancel();
    return;
  }
  setStudioBusy(true);
  setStatus("studio-status", "Рисую… обычно 20–60 секунд.");
  const res = await ipc.studioGenerate({ refId: studio.refId, prompt: $("studio-prompt").value, aspect: $("studio-aspect").value });
  setStudioBusy(false);
  if (res.error) {
    setStatus("studio-status", res.error, res.cancelled ? "" : "bad");
    return;
  }
  studio.file = res.file;
  $("studio-out").src = res.preview;
  $("studio-meta").textContent = `${res.width}×${res.height}, ${kb(res.bytes)}, JPEG для сайта`;
  $("studio-result").hidden = false;
  $("studio-go").textContent = "Нарисовать ещё";
  setStatus("studio-status", "Готово.", "ok");
});

$("studio-save").addEventListener("click", async () => {
  if (!studio.file) return;
  const res = await ipc.studioSave(studio.file);
  if (res.error) setStatus("studio-status", res.error, "bad");
  else if (res.saved) setStatus("studio-status", `Сохранено: ${res.filePath}`, "ok");
});

// ---------- theme: auto (system), light, dark; remembered per computer ----------

function applyTheme(choice) {
  if (choice === "light" || choice === "dark") document.documentElement.dataset.theme = choice;
  else delete document.documentElement.dataset.theme;
  for (const b of document.querySelectorAll("[data-theme-pick]")) {
    b.setAttribute("aria-pressed", String(b.dataset.themePick === (choice || "auto")));
  }
}
let savedTheme = "auto";
try {
  savedTheme = localStorage.getItem("theme") || "auto";
} catch {
  /* storage unavailable — follow the system */
}
applyTheme(savedTheme);
for (const b of document.querySelectorAll("[data-theme-pick]")) {
  b.addEventListener("click", () => {
    applyTheme(b.dataset.themePick);
    try {
      localStorage.setItem("theme", b.dataset.themePick);
    } catch {
      /* not remembered — fine */
    }
  });
}

// ---------- help, update, keyboard, init ----------

$("help-open").addEventListener("click", () => ($("help").hidden = false));
$("help-close").addEventListener("click", () => ($("help").hidden = true));
$("help").addEventListener("click", (e) => {
  if (e.target === $("help")) $("help").hidden = true;
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    $("help").hidden = true;
    closeViewer();
  }
  if (!$("viewer").hidden && e.target.tagName !== "TEXTAREA") {
    if (e.key === "ArrowLeft") step(-1);
    if (e.key === "ArrowRight") step(1);
  }
});

let updateUrl = null;
ipc.onUpdate(({ version, url }) => {
  updateUrl = url;
  $("update-text").textContent = `Вышла версия ${version}. Скачайте и установите поверх — результаты сохранятся.`;
  $("update").hidden = false;
});
$("update-open").addEventListener("click", () => updateUrl && ipc.openExternal(updateUrl));

(async () => {
  const s = await ipc.getState();
  $("version").textContent = `версия ${s.version}`;
  keys.providers = s.providers;
  keys.settings = s.settings;
  keys.defaultRules = s.defaultRedrawRules;
  $("provider").replaceChildren(...s.providers.map((p) => el("option", { value: p.id }, p.label)));
  $("provider").value = s.settings.provider;
  $("key").value = s.settings.keys[s.settings.provider] ?? "";
  $("recognize-model").value = s.settings.models.recognize;
  keys.shown = s.settings.provider;
  keys.savedProvider = s.settings.provider;
  $("redraw-rules").value = s.settings.redrawRules || s.defaultRedrawRules;
  renderProvider();
  renderKeySummary($("key").value ? true : undefined);
  // A saved key needs no attention: start folded, the list and results in focus.
  if ($("key").value) $("key-card").open = false;
  $("domains").value = s.domainsText ?? "";
  state.results = s.results ?? {};
  await refreshDomains();
})();
