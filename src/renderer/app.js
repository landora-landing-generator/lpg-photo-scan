"use strict";

const $ = (id) => document.getElementById(id);
const ipc = window.api;

const VERDICT = {
  faces: "Есть лица",
  people: "Части людей",
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
  pending: new Set(), // hosts of the running scan not finished yet
  total: 0,
  doneNow: 0,
  redraw: null, // { hosts, done, total } while a batch redraw runs
  selected: new Set(), // hosts ticked in the table
  picked: new Map(), // host → Set of image ids ticked in its frame grid
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
/** Display forms of page URLs (Cyrillic host and path), filled from the main process. */
const shownUrl = new Map();
async function learnUrls(urls) {
  const todo = [...new Set(urls)].filter((u) => !shownUrl.has(u));
  if (!todo.length) return;
  const shown = await ipc.displayUrls(todo);
  todo.forEach((u, i) => shownUrl.set(u, shown[i]));
}
const prettyUrl = (u) => shownUrl.get(u) ?? u;

const labelOf = (host) => state.hosts.find((h) => h.host === host)?.label ?? host;
/** Same rule as the main process (verdict.js): kept here so old saved results read the new way. */
const isFace = (img) => img.kind !== "body";
function verdictOfResult(r) {
  if (r.error) return "error";
  if (r.people.some(isFace)) return "faces";
  if (r.people.length) return "people";
  if (r.unsure.length || r.unchecked) return "unsure";
  return "clean";
}
const verdictOf = (host) => (state.results[host] ? verdictOfResult(state.results[host]) : "none");
const imagesOf = (r) => [...(r?.people ?? []), ...(r?.unsure ?? [])];
/** A result worth one more try: the site did not open, or some frames were left unchecked. */
const needsRetry = (r) => Boolean(r && (r.error || r.unchecked > 0));

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
 * Drawing model pickers in the viewer and the studio: one shared, remembered
 * choice from the saved service's list. The list itself is edited in the
 * settings — only models the service's catalog lists as drawing get in.
 */
function renderDrawModels() {
  const p = providerById(keys.savedProvider);
  if (!p) return;
  const list = keys.drawModels[p.id] ?? [];
  const saved = keys.settings.models.draw;
  let current = saved || p.drawModel;
  if (!list.some((m) => m.id === current)) {
    // A model the list no longer has (or a text model typed by hand in 0.2.x): fall back.
    current = list.some((m) => m.id === p.drawModel) ? p.drawModel : (list[0]?.id ?? "");
    commitDrawModel(current);
  }
  for (const id of ["viewer-model", "studio-model"]) {
    $(id).replaceChildren(...list.map((m) => el("option", { value: m.id, title: m.id }, m.label)));
    $(id).value = current;
  }
  renderDrawModelList();
}

function commitDrawModel(picked) {
  const p = providerById(keys.savedProvider);
  // The default is stored as "the service's default", so updates can move it.
  const model = picked === p.drawModel ? "" : picked;
  if (model === keys.settings.models.draw) return;
  keys.settings.models.draw = model;
  ipc.setDrawModel(model);
}

for (const id of ["viewer-model", "studio-model"]) {
  $(id).addEventListener("change", () => {
    commitDrawModel($(id).value);
    renderDrawModels();
  });
}

/** Settings: the drawing models of the service picked in the key form, each removable. */
function renderDrawModelList() {
  const pid = $("provider").value;
  const list = keys.drawModels[pid] ?? [];
  $("draw-model-list").replaceChildren(
    ...list.map((m) =>
      el(
        "li",
        {},
        el("span", { class: "name" }, m.label),
        el("code", {}, m.id),
        el(
          "button",
          {
            class: "icon small",
            title: list.length > 1 ? "Убрать из списка" : "Последнюю модель убрать нельзя",
            disabled: list.length <= 1 ? "" : null,
            onclick: () => applyDrawModels(ipc.removeDrawModel(pid, m.id), ""),
          },
          "×",
        ),
      ),
    ),
  );
}

async function applyDrawModels(call, okText) {
  setStatus("draw-model-status", okText === null ? "Проверяю по каталогу сервиса…" : "");
  const res = await call;
  if (res.error) {
    setStatus("draw-model-status", res.error, "bad");
    return res;
  }
  keys.settings = { ...res.settings, keys: keys.settings.keys };
  keys.drawModels = res.drawModels;
  renderDrawModels();
  setStatus("draw-model-status", res.added ? `Добавлена: ${res.added.label}.` : okText ?? "", "ok");
  return res;
}

// A fresh catalog arrived (start or saved key): gone models leave, new ones appear.
ipc.onDrawModels((view) => {
  keys.settings = { ...view.settings, keys: keys.settings.keys };
  keys.drawModels = view.drawModels;
  renderDrawModels();
});

$("draw-model-add").addEventListener("click", async () => {
  const id = $("draw-model-new").value.trim();
  if (!id) return;
  const res = await applyDrawModels(ipc.addDrawModel($("provider").value, id), null);
  if (!res.error) $("draw-model-new").value = "";
});
$("draw-model-new").addEventListener("keydown", (e) => {
  if (e.key === "Enter") $("draw-model-add").click();
});
$("draw-model-reset").addEventListener("click", () =>
  applyDrawModels(ipc.resetDrawModels($("provider").value), "Список снова как в каталоге сервиса."),
);

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
  const waiting = state.pending.size - state.working.size;
  $("progress-text").textContent = `Проверено ${state.doneNow} из ${state.total}${waiting > 0 ? ` · в очереди ${waiting}` : ""}`;
  $("progress-sites").replaceChildren(...[...state.working].map(([host, step]) => el("li", {}, `${labelOf(host)} — ${step}`)));
}

ipc.onBegin(({ total, hosts }) => {
  state.total = total;
  state.doneNow = 0;
  state.working.clear();
  state.pending = new Set(hosts);
  setRunning(true);
  renderProgress();
  render();
});
ipc.onMore(({ added, hosts }) => {
  state.total += added;
  for (const h of hosts) state.pending.add(h);
  renderProgress();
  render();
});
ipc.onProgress(({ host, step }) => {
  if (!state.pending.has(host)) return; // a late echo of a site already reported
  const first = !state.working.has(host);
  state.working.set(host, step);
  renderProgress();
  if (first) render(); // the row's button turns into "проверяю…"
});
ipc.onSite((result) => {
  state.results[result.host] = result;
  state.working.delete(result.host);
  state.pending.delete(result.host);
  state.doneNow++;
  renderProgress();
  render();
});
ipc.onEnd(({ stopped, fatal }) => {
  state.pending.clear();
  state.working.clear();
  setRunning(false);
  render();
  if (fatal) {
    setStatus("scan-status", `Проверка остановлена: ${fatal}`, "bad");
    $("key-card").open = true;
  }
  else if (stopped) setStatus("scan-status", `Остановлено на ${state.doneNow} из ${state.total}. Остальные проверятся при следующем нажатии.`);
  else setStatus("scan-status", `Готово: проверено сайтов — ${state.doneNow}.`, "ok");
});

// ---------- results ----------

/** One site, or the failed ones: joins a running scan or starts its own. */
async function scanHosts(hosts) {
  if (!hosts.length) return;
  setStatus("scan-status", "");
  const res = await ipc.scanHosts(hosts);
  if (res?.error) setStatus("scan-status", res.error, "bad");
}

$("retry-failed").addEventListener("click", () =>
  scanHosts(state.hosts.map((h) => h.host).filter((h) => needsRetry(state.results[h]) && !state.pending.has(h))),
);

$("clear").addEventListener("click", async () => {
  if (!confirm("Стереть результаты проверки? Список доменов останется.")) return;
  await ipc.clearResults();
  state.results = {};
  state.open.clear();
  state.picked.clear();
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
  state.redraw = p.finished ? null : p;
  render();
});

function renderChips() {
  const counts = { faces: 0, people: 0, unsure: 0, clean: 0, error: 0, none: 0 };
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

// ---------- checkboxes: several sites or frames, one action ----------

const pickedOf = (host) => state.picked.get(host) ?? new Set();
const notDrawn = (r) => (r?.people ?? []).filter((img) => !img.redraw);

/** Runs a batch redraw and says how it went — once, at the end. */
async function redrawItems(items) {
  if (!items.length) return;
  setStatus("batch-status", "");
  const res = await ipc.redrawBatch(items);
  if (res.error) return setStatus("batch-status", res.error, "bad");
  for (const { host, id } of items) pickedOf(host).delete(id);
  const failed = res.errors.length;
  const text = res.stopped
    ? `Остановлено. Перерисовано кадров: ${res.done} из ${res.total}.`
    : failed
      ? `Перерисовано ${res.done} из ${res.total}. Не получилось ${failed}: ${res.errors[0]}`
      : `Готово: перерисовано кадров — ${res.done}.`;
  setStatus("batch-status", text, failed ? "bad" : "ok");
  render();
}

async function saveSites(hosts) {
  setStatus("batch-status", "");
  const res = await ipc.saveSites(hosts);
  if (res.error) setStatus("batch-status", res.error, "bad");
  else if (res.saved) setStatus("batch-status", `Сохранено кадров: ${res.count}${res.sites > 1 ? ` с ${res.sites} сайтов` : ""}.`, "ok");
}

/** Above the table: what is ticked and what can be done with it; the running batch with its stop. */
function renderBatchBar() {
  const busy = state.redraw;
  const hosts = state.hosts.map((h) => h.host).filter((h) => state.selected.has(h));
  const bar = $("batch");
  if (busy) {
    // CSP forbids style attributes; the CSSOM property is allowed.
    const fill = el("div");
    fill.style.width = `${Math.round((busy.done / busy.total) * 100)}%`;
    bar.replaceChildren(
      el("span", { class: "batch-text" }, `Перерисовываю кадры: ${busy.done} из ${busy.total}`),
      el("div", { class: "bar mini" }, fill),
      el("button", { class: "danger push-right", onclick: () => ipc.stopRedraw() }, "Остановить"),
    );
    bar.hidden = false;
    return;
  }
  if (!hosts.length) {
    bar.hidden = true;
    return;
  }
  const results = hosts.map((h) => state.results[h]);
  const toDraw = results.reduce((n, r) => n + notDrawn(r).length, 0);
  const drawn = results.reduce((n, r) => n + imagesOf(r).filter((img) => img.redraw).length, 0);
  const idle = hosts.filter((h) => !state.pending.has(h));
  bar.replaceChildren(
    el("span", { class: "batch-text" }, `Выбрано: ${plural(hosts.length, "сайт", "сайта", "сайтов")}`),
    el("button", { disabled: !idle.length, onclick: () => scanHosts(idle) }, "Проверить"),
    el(
      "button",
      {
        class: "primary",
        disabled: !toDraw,
        title: toDraw ? "Перерисовать все кадры с людьми на выбранных сайтах, которые ещё не перерисованы" : "На выбранных сайтах нечего перерисовывать",
        onclick: () => redrawItems(hosts.flatMap((h) => notDrawn(state.results[h]).map((img) => ({ host: h, id: img.id })))),
      },
      `Перерисовать кадры с людьми${toDraw ? ` (${toDraw})` : ""}`,
    ),
    el("button", { disabled: !drawn, onclick: () => saveSites(hosts) }, `Скачать новые кадры${drawn ? ` (${drawn})` : ""}`),
    el(
      "button",
      {
        class: "ghost push-right",
        onclick: () => {
          state.selected.clear();
          render();
        },
      },
      "Снять выбор",
    ),
  );
  bar.hidden = false;
}

/** Above a site's frames: redraw the ticked ones, or all with people; download what is drawn. */
function siteActions(host, r) {
  const drawn = imagesOf(r).filter((img) => img.redraw).length;
  const left = notDrawn(r);
  const picked = [...pickedOf(host)].filter((id) => imagesOf(r).some((img) => img.id === id));
  const busy = Boolean(state.redraw);
  const pick = (ids) => {
    state.picked.set(host, new Set(ids));
    render();
  };
  return el(
    "div",
    { class: "site-actions" },
    picked.length
      ? el(
          "button",
          { class: "primary", disabled: busy, onclick: () => redrawItems(picked.map((id) => ({ host, id }))) },
          `Перерисовать выбранные (${picked.length})`,
        )
      : left.length > 0 &&
          el(
            "button",
            { class: "primary", disabled: busy, onclick: () => redrawItems(left.map((img) => ({ host, id: img.id }))) },
            `Перерисовать все кадры с людьми (${left.length})`,
          ),
    picked.length
      ? el("button", { class: "ghost", onclick: () => pick([]) }, "Снять выбор")
      : el("button", { class: "ghost", onclick: () => pick(imagesOf(r).map((img) => img.id)) }, "Выбрать все кадры"),
    drawn > 0 && el("button", { class: "push-right", onclick: () => saveSites([host]) }, `Скачать новые кадры в папку (${drawn})`),
  );
}

function thumbGrid(host, r) {
  const grid = el("div", { class: "thumbs" });
  const picked = pickedOf(host);
  for (const [list, label] of [
    [r.people.filter(isFace), "Лица"],
    [r.people.filter((img) => !isFace(img)), "Части людей — руки, фигура со спины"],
    [r.unsure, "Нейросеть не уверена — посмотрите сами"],
  ]) {
    if (!list.length) continue;
    grid.append(el("div", { class: "label" }, `${label} (${list.length})`));
    for (const img of list) {
      let pagePath = prettyUrl(img.page);
      try {
        pagePath = decodeURI(new URL(img.page).pathname);
      } catch {
        /* keep as is */
      }
      const box = el("input", {
        type: "checkbox",
        class: "pick",
        title: "Выбрать кадр",
        "aria-label": "Выбрать кадр",
        checked: picked.has(img.id),
        onchange: (e) => {
          const set = pickedOf(host);
          e.target.checked ? set.add(img.id) : set.delete(img.id);
          state.picked.set(host, set);
          render();
        },
      });
      grid.append(
        el(
          "figure",
          { class: picked.has(img.id) ? "picked" : null },
          box,
          img.redraw && el("span", { class: "badge" }, "✓ новый"),
          el("img", { src: img.thumb, alt: "", title: "Открыть: посмотреть, перерисовать, скачать", onclick: () => openViewer(host, img.id) }),
          el(
            "figcaption",
            {},
            el(
              "a",
              { href: "#", title: `Открыть страницу с этим кадром: ${prettyUrl(img.page)}`, onclick: (e) => (e.preventDefault(), ipc.openExternal(img.page)) },
              `стр. ${pagePath} ↗`,
            ),
          ),
        ),
      );
    }
  }
  return el("div", {}, siteActions(host, r), grid);
}

/** The row's own button: scan this one site (again), or where it stands in the running scan. */
function rowAction(host, r) {
  if (state.working.has(host)) return el("span", { class: "hint" }, "проверяю…");
  if (state.pending.has(host)) return el("span", { class: "hint" }, "в очереди");
  return el(
    "button",
    {
      class: needsRetry(r) ? "small" : "small ghost",
      title: r ? "Проверить только этот сайт ещё раз" : "Проверить только этот сайт",
      onclick: (e) => {
        e.stopPropagation();
        scanHosts([host]);
      },
    },
    r ? "Заново" : "Проверить",
  );
}

function renderRetry() {
  const n = state.hosts.filter(({ host }) => needsRetry(state.results[host]) && !state.pending.has(host)).length;
  $("retry-failed").hidden = n === 0;
  $("retry-failed").textContent = `Повторить сайты с ошибками (${n})`;
}

$("pick-all").addEventListener("change", (e) => {
  for (const { host } of state.hosts) {
    if (state.filter && verdictOf(host) !== state.filter) continue;
    e.target.checked ? state.selected.add(host) : state.selected.delete(host);
  }
  render();
});

function render() {
  // A domain taken off the list is not ticked any more.
  const listed = new Set(state.hosts.map((h) => h.host));
  for (const h of state.selected) if (!listed.has(h)) state.selected.delete(h);
  renderChips();
  renderRetry();
  const rows = [];
  for (const { host, label } of state.hosts) {
    const v = verdictOf(host);
    if (state.filter && state.filter !== v) continue;
    const r = state.results[host];
    const expandable = r && imagesOf(r).length > 0;
    const isOpen = expandable && state.open.has(host);
    const note =
      r?.error ?? ([r?.note, r?.unchecked ? `не проверено кадров: ${r.unchecked}` : null].filter(Boolean).join("; ") || null);
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
          { class: "pick", onclick: (e) => e.stopPropagation() },
          el("input", {
            type: "checkbox",
            "aria-label": `Выбрать ${label}`,
            checked: state.selected.has(host),
            onchange: (e) => {
              e.target.checked ? state.selected.add(host) : state.selected.delete(host);
              render();
            },
          }),
        ),
        el(
          "td",
          {},
          el("span", { class: "caret" }, expandable ? (isOpen ? "▾" : "▸") : ""),
          el("span", { class: "site-name" }, label),
          el(
            "button",
            {
              class: "open-site",
              title: "Открыть сайт в браузере",
              "aria-label": `Открыть ${label} в браузере`,
              onclick: (e) => {
                e.stopPropagation();
                ipc.openExternal(`https://${host}/`);
              },
            },
            "↗",
          ),
          note ? el("div", { class: "note" }, note) : null,
        ),
        el("td", {}, el("span", { class: `tag ${v}` }, VERDICT[v])),
        el("td", { class: "n" }, r && !r.error ? String(r.people.filter(isFace).length) : ""),
        el("td", { class: "n" }, r && !r.error ? String(r.people.filter((img) => !isFace(img)).length) : ""),
        el("td", { class: "n" }, r && !r.error ? String(r.unsure.length) : ""),
        el("td", { class: "n" }, r ? String(imagesOf(r).filter((i) => i.redraw).length || "") : ""),
        el("td", { class: "n" }, r && !r.error ? String(r.images) : ""),
        el("td", { class: "act" }, rowAction(host, r)),
      ),
    );
    if (isOpen) rows.push(el("tr", { class: "details" }, el("td", { colspan: "9" }, thumbGrid(host, r))));
  }
  $("rows").replaceChildren(...rows);
  // Header box: all visible rows ticked / some / none.
  const visible = state.hosts.filter(({ host }) => !state.filter || verdictOf(host) === state.filter).map((h) => h.host);
  const ticked = visible.filter((h) => state.selected.has(h)).length;
  $("pick-all").checked = visible.length > 0 && ticked === visible.length;
  $("pick-all").indeterminate = ticked > 0 && ticked < visible.length;
  $("pick-all").disabled = visible.length === 0;
  renderBatchBar();
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
  await learnUrls([img.page]);
  $("viewer-page").textContent = prettyUrl(img.page);
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
  $("viewer-new").parentElement.classList.toggle("loading", on);
  $("viewer-redraw").textContent = on ? "Отменить" : currentImage()?.redraw ? "Перерисовать ещё раз" : "Перерисовать";
  $("viewer-redraw").classList.toggle("primary", !on);
  $("viewer-redraw").classList.toggle("danger", on);
  // Off while drawing; back on by position — not by the state "on" left behind.
  const list = viewerList();
  const pos = list.findIndex((x) => x.id === viewer.id);
  $("viewer-prev").disabled = on || pos <= 0;
  $("viewer-next").disabled = on || pos >= list.length - 1;
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
  clearInterval(drawClock.timer);
  drawClock.timer = null;
  showStep("Начинаю…");
  $("viewer-new").removeAttribute("src");
  // Said once for the whole drawing, not repeated with every step.
  setStatus("viewer-status", "Можно отменить или закрыть окно — рисование остановится.");
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

// The step in words plus the time since the start: a slow model is seen working, not hung.
const drawClock = { started: 0, step: "", timer: null };
function showStep(step) {
  drawClock.step = step;
  if (!drawClock.timer) {
    drawClock.started = Date.now();
    drawClock.timer = setInterval(renderStep, 1000);
  }
  renderStep();
}
function renderStep() {
  if (!viewer.busy) {
    clearInterval(drawClock.timer);
    drawClock.timer = null;
    return;
  }
  const sec = Math.floor((Date.now() - drawClock.started) / 1000);
  $("viewer-new-wait").textContent = `${drawClock.step} · ${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
}

ipc.onImageStep(({ id, step }) => {
  if (viewer.busy && viewer.id === id) showStep(step);
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
  // The result frame shows the wave while drawing, and keeps the old result hidden meanwhile.
  $("studio-result").hidden = !on && !studio.file;
  $("studio-out").parentElement.classList.toggle("loading", on);
  $("studio-wait").hidden = !on;
  if (on) $("studio-out").removeAttribute("src");
  $("studio-save").disabled = on;
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
  setStatus("studio-status", "");
  const res = await ipc.studioGenerate({ refId: studio.refId, prompt: $("studio-prompt").value, aspect: $("studio-aspect").value });
  setStudioBusy(false);
  if (res.error) {
    setStatus("studio-status", res.error, res.cancelled ? "" : "bad");
    if (studio.lastPreview) $("studio-out").src = studio.lastPreview;
    return;
  }
  studio.lastPreview = res.preview;
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
  keys.drawModels = s.drawModels;
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
