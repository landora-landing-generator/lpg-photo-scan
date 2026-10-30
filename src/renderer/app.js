"use strict";

const $ = (id) => document.getElementById(id);
const api = window.api;

const VERDICT = {
  people: "Есть люди",
  unsure: "Проверить глазами",
  clean: "Людей нет",
  error: "Сайт не открылся",
  none: "Не проверен",
};

const state = {
  hosts: [], // parsed domain list, in order
  results: {}, // host → result
  filter: null, // verdict shown, null = all
  open: new Set(), // expanded rows
  running: false,
  working: new Map(), // host → current step
  total: 0,
  doneNow: 0,
};

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const c of children) if (c != null) node.append(c);
  return node;
}

function setStatus(id, text, kind = "") {
  $(id).textContent = text;
  $(id).className = `status ${kind}`;
}

const verdictOf = (host) => state.results[host]?.verdict ?? "none";

// ---------- key ----------

$("key-toggle").addEventListener("click", () => {
  const show = $("key").type === "password";
  $("key").type = show ? "text" : "password";
  $("key-toggle").textContent = show ? "Скрыть" : "Показать";
});

const keyState = { providers: [], provider: "openrouter", keys: {} };

function renderProviders() {
  $("providers").replaceChildren(
    ...keyState.providers.map((p) =>
      el(
        "button",
        {
          role: "radio",
          "aria-checked": String(p.id === keyState.provider),
          onclick: () => selectProvider(p.id),
        },
        p.label,
      ),
    ),
  );
  const p = keyState.providers.find((x) => x.id === keyState.provider);
  $("key-hint").textContent = p ? `${p.hint} Стоимость: ${p.cost}.` : "";
}

function selectProvider(id) {
  keyState.keys[keyState.provider] = $("key").value.trim();
  keyState.provider = id;
  $("key").value = keyState.keys[id] ?? "";
  // A key saved earlier for this service becomes active at once; a new one waits for "Сохранить и проверить".
  if (keyState.keys[id]) {
    api.saveKey(id, keyState.keys[id]);
    setStatus("key-status", "Ключ сохранён — проверка пойдёт через этот сервис.", "ok");
  } else {
    setStatus("key-status", "");
  }
  renderProviders();
}

$("key-save").addEventListener("click", async () => {
  const key = $("key").value.trim();
  setStatus("key-status", "Проверяю ключ…");
  const res = await api.checkKey(keyState.provider, key);
  if (res.ok) {
    await api.saveKey(keyState.provider, key);
    keyState.keys[keyState.provider] = key;
  }
  setStatus("key-status", res.message + (res.ok ? " Ключ сохранён — проверка пойдёт через него." : ""), res.ok ? "ok" : "bad");
});

// ---------- domains ----------

let parseTimer;
$("domains").addEventListener("input", () => {
  clearTimeout(parseTimer);
  parseTimer = setTimeout(refreshDomains, 250);
});

async function refreshDomains() {
  state.hosts = await api.parseDomains($("domains").value);
  $("domains-count").textContent = `Доменов: ${state.hosts.length}`;
  render();
}

// ---------- scan ----------

async function start(again) {
  setStatus("scan-status", "");
  await refreshDomains();
  const res = await api.startScan($("domains").value, again);
  if (res?.error) setStatus("scan-status", res.error, "bad");
}

$("scan-start").addEventListener("click", () => start(false));
$("scan-again").addEventListener("click", () => {
  if (confirm("Проверить весь список заново? Это снова потратит деньги на ключе.")) start(true);
});
$("scan-stop").addEventListener("click", () => {
  $("scan-stop").disabled = true;
  $("scan-stop").textContent = "Останавливаю…";
  api.stopScan();
});

function setRunning(on) {
  state.running = on;
  $("scan-start").hidden = on;
  $("scan-again").hidden = on;
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
  $("progress-sites").replaceChildren(
    ...[...state.working].map(([host, step]) => el("li", {}, `${host} — ${step}`)),
  );
}

api.onBegin(({ total }) => {
  state.total = total;
  state.doneNow = 0;
  state.working.clear();
  setRunning(true);
  renderProgress();
});
api.onProgress(({ host, step }) => {
  state.working.set(host, step);
  renderProgress();
});
api.onSite((result) => {
  state.results[result.host] = result;
  state.working.delete(result.host);
  state.doneNow++;
  renderProgress();
  render();
});
api.onEnd(({ stopped, fatal }) => {
  setRunning(false);
  if (fatal) setStatus("scan-status", `Проверка остановлена: ${fatal}`, "bad");
  else if (stopped) setStatus("scan-status", `Остановлено. Проверено ${state.doneNow} из ${state.total}; остальные проверятся при следующем нажатии «Проверить сайты».`);
  else setStatus("scan-status", `Готово: проверено сайтов — ${state.doneNow}.`, "ok");
});

// ---------- results ----------

$("clear").addEventListener("click", async () => {
  if (!confirm("Стереть сохранённые результаты проверки? Список доменов останется.")) return;
  await api.clearResults();
  state.results = {};
  state.open.clear();
  render();
});

$("excel").addEventListener("click", async () => {
  const res = await api.saveExcel();
  if (res.saved) setStatus("scan-status", `Сохранено: ${res.filePath}`, "ok");
});

function renderChips() {
  const counts = { people: 0, unsure: 0, clean: 0, error: 0, none: 0 };
  for (const h of state.hosts) counts[verdictOf(h)]++;
  const chips = Object.entries(counts)
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
    );
  $("chips").replaceChildren(...chips);
}

function thumbGrid(r) {
  const grid = el("div", { class: "thumbs" });
  for (const [list, label] of [
    [r.people, "Кадры с людьми"],
    [r.unsure, "Нейросеть не уверена — посмотрите сами"],
  ]) {
    if (!list.length) continue;
    grid.append(el("div", { class: "label" }, `${label} (${list.length})`));
    for (const img of list) {
      const path = (() => {
        try {
          return new URL(img.page).pathname;
        } catch {
          return img.page;
        }
      })();
      grid.append(
        el(
          "figure",
          {},
          el("img", { src: img.thumb, alt: "", title: "Открыть картинку в браузере", onclick: () => api.openExternal(img.url) }),
          el("figcaption", {}, "стр. ", el("a", { onclick: () => api.openExternal(img.page), title: img.page }, path)),
        ),
      );
    }
  }
  return grid;
}

function render() {
  renderChips();
  const rows = [];
  for (const host of state.hosts) {
    const v = verdictOf(host);
    if (state.filter && state.filter !== v) continue;
    const r = state.results[host];
    const expandable = r && (r.people.length || r.unsure.length);
    const isOpen = expandable && state.open.has(host);
    const note = r?.error ?? (r?.unchecked ? `не проверено кадров: ${r.unchecked}` : null);
    rows.push(
      el(
        "tr",
        {
          class: `site${isOpen ? " open" : ""}`,
          title: expandable ? "Нажмите, чтобы увидеть кадры" : "",
          onclick: () => {
            if (!expandable) return;
            state.open.has(host) ? state.open.delete(host) : state.open.add(host);
            render();
          },
        },
        el("td", {}, `${expandable ? (isOpen ? "▾ " : "▸ ") : ""}${host}`, note ? el("div", { class: "note" }, note) : null),
        el("td", {}, el("span", { class: `tag ${v}` }, VERDICT[v])),
        el("td", { class: "n" }, r ? String(r.people.length) : ""),
        el("td", { class: "n" }, r ? String(r.unsure.length) : ""),
        el("td", { class: "n" }, r && !r.error ? String(r.images) : ""),
        el("td", { class: "n" }, r && !r.error ? String(r.pages) : ""),
      ),
    );
    if (isOpen) rows.push(el("tr", {}, el("td", { colspan: "6" }, thumbGrid(r))));
  }
  $("rows").replaceChildren(...rows);
  $("empty").hidden = rows.length > 0;
  $("empty").textContent = state.hosts.length ? "Нет сайтов с таким итогом." : "Пока ничего не проверено.";
}

// ---------- help, update, init ----------

$("help-open").addEventListener("click", () => ($("help").hidden = false));
$("help-close").addEventListener("click", () => ($("help").hidden = true));
$("help").addEventListener("click", (e) => {
  if (e.target === $("help")) $("help").hidden = true;
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") $("help").hidden = true;
});

let updateUrl = null;
api.onUpdate(({ version, url }) => {
  updateUrl = url;
  $("update-text").textContent = `Вышла новая версия ${version}. Скачайте её и установите поверх этой — результаты сохранятся.`;
  $("update").hidden = false;
});
$("update-open").addEventListener("click", () => updateUrl && api.openExternal(updateUrl));

(async () => {
  const s = await api.getState();
  $("version").textContent = `версия ${s.version}`;
  keyState.providers = s.providers;
  keyState.provider = s.provider;
  keyState.keys = s.keys ?? {};
  $("key").value = keyState.keys[s.provider] ?? "";
  renderProviders();
  if ($("key").value) setStatus("key-status", "Ключ сохранён.", "ok");
  $("domains").value = s.domainsText ?? "";
  state.results = s.results ?? {};
  await refreshDomains();
})();
