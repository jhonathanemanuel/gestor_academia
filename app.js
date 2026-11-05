import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  collection, doc, addDoc, updateDoc, deleteDoc, onSnapshot, writeBatch,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import { firebaseConfig } from "./firebase-config.js";

/* ---------- Constantes e utilitários ---------- */
const DAYS = ["Seg", "Ter", "Qua", "Qui", "Sex", "Sáb", "Dom"];
const DAYS_FULL = ["Segunda", "Terça", "Quarta", "Quinta", "Sexta", "Sábado", "Domingo"];
const COLORS = { dark: "#091517", light: "#eaf1f0" };
const ICONS = {
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  train: '<path d="M6.5 6.5v11M17.5 6.5v11M3.5 9v6M20.5 9v6M6.5 12h11"/>',
  list: '<path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01"/>',
  tune: '<path d="M4 7h10M18 7h2M4 17h2M10 17h10"/><circle cx="16" cy="7" r="2"/><circle cx="8" cy="17" r="2"/>',
};

const $ = (s) => document.querySelector(s);
const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* ignora */ } },
  del: (k) => { try { localStorage.removeItem(k); } catch { /* ignora */ } },
};
const todayIdx = () => (new Date().getDay() + 6) % 7;
const fmt = (n) => Number(n).toLocaleString("pt-BR");
const byName = (a, b) => (a.name || "").localeCompare(b.name || "", "pt-BR");

// Cria elementos sem innerHTML (evita XSS com dados vindos do banco).
function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "class") el.className = v;
    else if (v !== false && v != null) el.setAttribute(k, v === true ? "" : v);
  }
  el.append(...kids.flat().filter((k) => k != null && k !== false));
  return el;
}
function icon(name, w = 2) {
  const s = h("span", { class: "ico", "aria-hidden": "true" });
  s.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</svg>`;
  return s;
}
const field = (label, input) => h("label", { class: "field" }, h("span", {}, label), input);
const empty = (t, s) => h("div", { class: "empty" }, h("b", {}, t), h("p", {}, s));

let toastTimer;
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 2800);
}

function setTheme(t) {
  document.documentElement.dataset.theme = t;
  store.set("theme", t);
  $("meta[name=theme-color]").content = COLORS[t];
}

/* ---------- Estado e dados (Firestore) ---------- */
const state = { user: null, tab: "treino", day: todayIdx(), categories: [], exercises: [], items: [] };
let db, auth;
let unsubs = [];

const col = (n) => collection(db, "workspace", "main", n);
const ref = (n, id) => doc(db, "workspace", "main", n, id);
const run = (p) => p.catch((e) => { console.error(e); toast("Não foi possível salvar. Tente de novo."); });
const sortedItems = () => [...state.items].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
const catOf = (name) => {
  const ex = state.exercises.find((e) => (e.name || "").toLowerCase() === (name || "").toLowerCase());
  return ex && state.categories.find((c) => c.id === ex.categoryId);
};

function subscribe() {
  unsubs.forEach((u) => u());
  unsubs = ["categories", "exercises", "items"].map((n) =>
    onSnapshot(col(n),
      (snap) => { state[n] = snap.docs.map((d) => ({ id: d.id, ...d.data() })); render(); },
      () => toast("Sem permissão ou falha na sincronização"))
  );
}

function unsubscribe() {
  unsubs.forEach((u) => u());
  unsubs = [];
  Object.assign(state, { categories: [], exercises: [], items: [] });
}

function logout() {
  if (confirm("Sair da conta neste aparelho?")) signOut(auth);
}

function saveItem(id, data) {
  state.day = data.day;
  run(id ? updateDoc(ref("items", id), data) : addDoc(col("items"), { ...data, done: false, order: Date.now() }));
}

function resetWeek() {
  const done = state.items.filter((i) => i.done);
  if (!done.length) return toast("Nada para desmarcar");
  if (!confirm("Desmarcar todos os exercícios concluídos?")) return;
  const b = writeBatch(db);
  done.forEach((i) => b.update(ref("items", i.id), { done: false }));
  run(b.commit());
  toast("Semana reiniciada");
}

function exportCsv() {
  const safe = (v) => (typeof v === "string" && /^[=+\-@]/.test(v) ? "'" + v : v);
  const esc = (v) => `"${String(safe(v) ?? "").replace(/"/g, '""')}"`;
  const rows = [["dia", "exercicio", "categoria", "series", "repeticoes", "peso_kg", "concluido"]];
  sortedItems().sort((a, b) => a.day - b.day).forEach((i) =>
    rows.push([DAYS_FULL[i.day], i.name, catOf(i.name)?.name ?? "", i.sets, i.reps, i.weight, i.done ? "sim" : "nao"]));
  const csv = "\ufeff" + rows.map((r) => r.map(esc).join(";")).join("\r\n");
  const a = h("a", { href: URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" })), download: "treino.csv" });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/* ---------- Diálogo genérico ---------- */
const dlg = $("#dlg");
dlg.addEventListener("click", (e) => { if (e.target === dlg) dlg.close(); });

function openDialog(title, body, { onSubmit, onDelete, label = "Salvar" }) {
  const form = h("form", { class: "sheet" },
    h("h2", {}, title), ...body,
    h("div", { class: "actions" },
      onDelete && h("button", { type: "button", class: "btn btn-danger", onclick: () => { if (confirm("Excluir este item?")) { onDelete(); dlg.close(); } } }, "Excluir"),
      h("span", { class: "spacer" }),
      h("button", { type: "button", class: "btn btn-ghost", onclick: () => dlg.close() }, "Cancelar"),
      h("button", { class: "btn btn-primary" }, label)));
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    onSubmit(Object.fromEntries(new FormData(form)));
    dlg.close();
    render();
  });
  dlg.replaceChildren(form);
  dlg.showModal();
}

function itemDialog(item) {
  const num = (n, v, min, max, step = 1) =>
    h("input", { name: n, type: "number", inputmode: step < 1 ? "decimal" : "numeric", min, max, step, required: true, value: v });
  openDialog(item ? "Editar exercício" : "Novo exercício no treino", [
    field("Exercício", h("input", { name: "name", required: true, maxlength: 60, list: "ex-list", autocomplete: "off", value: item?.name ?? "" })),
    h("datalist", { id: "ex-list" }, [...state.exercises].sort(byName).map((e) => h("option", { value: e.name }))),
    h("div", { class: "row" },
      field("Séries", num("sets", item?.sets ?? 3, 1, 99)),
      field("Reps", num("reps", item?.reps ?? 12, 1, 999)),
      field("Peso (kg)", num("weight", item?.weight ?? 0, 0, 999, 0.5))),
    field("Dia", h("select", { name: "day" }, DAYS_FULL.map((d, i) => h("option", { value: i, selected: i === (item?.day ?? state.day) }, d)))),
  ], {
    onSubmit: (f) => saveItem(item?.id, { name: f.name.trim(), sets: +f.sets, reps: +f.reps, weight: +f.weight, day: +f.day }),
    onDelete: item && (() => run(deleteDoc(ref("items", item.id)))),
  });
}

function categoryDialog(c) {
  openDialog(c ? "Editar categoria" : "Nova categoria", [
    field("Nome", h("input", { name: "name", required: true, maxlength: 30, value: c?.name ?? "" })),
  ], {
    onSubmit: (f) => run(c ? updateDoc(ref("categories", c.id), { name: f.name.trim() }) : addDoc(col("categories"), { name: f.name.trim() })),
    onDelete: c && (() => {
      const b = writeBatch(db);
      state.exercises.filter((e) => e.categoryId === c.id).forEach((e) => b.update(ref("exercises", e.id), { categoryId: null }));
      b.delete(ref("categories", c.id));
      run(b.commit());
    }),
  });
}

function exerciseDialog(ex) {
  const options = [h("option", { value: "" }, "Sem categoria"),
    ...[...state.categories].sort(byName).map((c) => h("option", { value: c.id, selected: c.id === ex?.categoryId }, c.name))];
  openDialog(ex ? "Editar exercício" : "Novo exercício", [
    field("Nome", h("input", { name: "name", required: true, maxlength: 60, value: ex?.name ?? "" })),
    field("Categoria", h("select", { name: "category" }, options)),
  ], {
    onSubmit: (f) => {
      const data = { name: f.name.trim(), categoryId: f.category || null };
      run(ex ? updateDoc(ref("exercises", ex.id), data) : addDoc(col("exercises"), data));
    },
    onDelete: ex && (() => run(deleteDoc(ref("exercises", ex.id)))),
  });
}

/* ---------- Telas ---------- */
const AUTH_ERRORS = {
  "auth/invalid-credential": "E-mail ou senha incorretos.",
  "auth/invalid-email": "E-mail inválido.",
  "auth/too-many-requests": "Muitas tentativas. Aguarde um pouco e tente de novo.",
  "auth/network-request-failed": "Sem conexão. Verifique a internet.",
};

function loginView() {
  const email = h("input", { type: "email", required: true, autocomplete: "username", inputmode: "email" });
  const pass = h("input", { type: "password", required: true, autocomplete: "current-password" });
  const err = h("p", { class: "form-error", role: "alert" });
  const btn = h("button", { class: "btn btn-primary" }, "Entrar");
  const onsubmit = async (e) => {
    e.preventDefault();
    btn.disabled = true;
    err.textContent = "";
    try {
      await signInWithEmailAndPassword(auth, email.value.trim(), pass.value);
    } catch (ex) {
      err.textContent = AUTH_ERRORS[ex.code] || "Não foi possível entrar. Tente de novo.";
      btn.disabled = false;
    }
  };
  return h("section", { class: "welcome" },
    h("div", { class: "logo" }, icon("train", 2.2)),
    h("h1", {}, "Meu treino"),
    h("p", { class: "muted" }, "Entre com o seu e-mail e senha."),
    h("form", { class: "login", onsubmit }, field("E-mail", email), field("Senha", pass), err, btn));
}

function header() {
  const title = { treino: DAYS_FULL[state.day], exercicios: "Exercícios", ajustes: "Ajustes" }[state.tab];
  return h("header", { class: "top" }, h("h1", {}, title),
    state.tab === "treino" && state.day === todayIdx() && h("span", { class: "badge" }, "Hoje"));
}

function itemCard(i) {
  const cat = catOf(i.name);
  return h("li", { class: "card" + (i.done ? " done" : "") },
    h("button", { class: "check", role: "checkbox", "aria-checked": String(!!i.done), "aria-label": `Concluir ${i.name}`,
      onclick: () => run(updateDoc(ref("items", i.id), { done: !i.done })) }, icon("check", 3.2)),
    h("button", { class: "card-main", onclick: () => itemDialog(i) },
      h("span", { class: "name" }, i.name),
      h("span", { class: "meta" },
        h("span", { class: "chip strong" }, `${i.sets}×${i.reps}`),
        h("span", { class: "chip strong" }, i.weight ? `${fmt(i.weight)} kg` : "Sem carga"),
        cat && h("span", { class: "chip" }, cat.name))));
}

function treinoView() {
  const items = sortedItems().filter((i) => i.day === state.day);
  const done = items.filter((i) => i.done).length;
  const pct = items.length ? Math.round((done / items.length) * 100) : 0;
  return h("div", {},
    h("div", { class: "days", role: "tablist", "aria-label": "Dias da semana" },
      DAYS.map((d, i) => h("button", { class: "day", role: "tab", "aria-selected": String(i === state.day), "aria-label": DAYS_FULL[i],
        onclick: () => { state.day = i; render(); } },
        h("span", {}, d), h("i", { class: state.items.some((x) => x.day === i) ? "dot on" : "dot" })))),
    h("div", { class: "progress-wrap" },
      h("div", { class: "progress", role: "progressbar", "aria-label": "Progresso do dia", "aria-valuemin": 0, "aria-valuemax": 100, "aria-valuenow": pct },
        h("div", { style: `width:${pct}%` })),
      h("span", { class: "muted" }, items.length ? `${done}/${items.length}` : "")),
    items.length ? h("ul", { class: "list" }, items.map(itemCard)) : empty("Nenhum exercício neste dia", "Toque em + para montar o treino."),
    h("button", { class: "fab", "aria-label": "Adicionar exercício ao treino", onclick: () => itemDialog() }, icon("plus", 2.6)));
}

function exerciciosView() {
  const cats = [...state.categories].sort(byName);
  const groups = [...cats, { id: null, name: "Sem categoria" }]
    .map((c) => ({ c, list: state.exercises.filter((e) => (e.categoryId ?? null) === c.id).sort(byName) }))
    .filter((g) => g.list.length);
  const head = (t, label, fn) => h("div", { class: "section-head" }, h("h2", {}, t),
    h("button", { class: "btn btn-small", onclick: fn }, icon("plus"), label));
  return h("div", {},
    head("Categorias", "Nova", () => categoryDialog()),
    cats.length
      ? h("div", { class: "chips" }, cats.map((c) => h("button", { class: "chip chip-btn", onclick: () => categoryDialog(c) }, c.name)))
      : h("p", { class: "muted", style: "margin-bottom:20px" }, "Crie categorias como Peito, Costas ou Pernas."),
    head("Biblioteca", "Novo", () => exerciseDialog()),
    groups.length
      ? groups.map((g) => h("section", {}, h("h3", { class: "group" }, g.c.name),
          h("ul", { class: "list" }, g.list.map((e) => h("li", { class: "card" },
            h("button", { class: "card-main", onclick: () => exerciseDialog(e) }, h("span", { class: "name" }, e.name)))))))
      : empty("Nenhum exercício cadastrado", "Cadastre os exercícios e organize por categoria."));
}

function ajustesView() {
  const theme = document.documentElement.dataset.theme;
  return h("div", {},
    h("h3", { class: "group" }, "Aparência"),
    h("div", { class: "seg", role: "group", "aria-label": "Tema" },
      [["dark", "Escuro"], ["light", "Claro"]].map(([v, l]) =>
        h("button", { "aria-pressed": String(theme === v), onclick: () => { setTheme(v); render(); } }, l))),
    h("h3", { class: "group" }, "Conta"),
    h("div", { class: "panel" },
      h("p", { class: "muted" }, "Conectado como"),
      h("code", { class: "code" }, state.user.email),
      h("button", { class: "btn btn-danger", onclick: logout }, "Sair da conta")),
    h("h3", { class: "group" }, "Dados"),
    h("div", { class: "panel" },
      h("button", { class: "btn", onclick: exportCsv }, "Exportar CSV"),
      h("button", { class: "btn", onclick: resetWeek }, "Reiniciar semana")));
}

const TABS = [["treino", "Treino", "train"], ["exercicios", "Exercícios", "list"], ["ajustes", "Ajustes", "tune"]];
const VIEWS = { treino: treinoView, exercicios: exerciciosView, ajustes: ajustesView };

function nav() {
  return h("nav", { class: "nav", "aria-label": "Principal" },
    h("div", {}, TABS.map(([id, label, ic]) =>
      h("button", { "aria-current": state.tab === id ? "page" : false,
        onclick: () => { state.tab = id; render(); window.scrollTo(0, 0); } }, icon(ic), h("span", {}, label)))));
}

function render() {
  const root = $("#app");
  if (!state.user) return root.replaceChildren(loginView());
  root.replaceChildren(header(), h("main", {}, VIEWS[state.tab]()), nav());
}

/* ---------- Inicialização ---------- */
function init() {
  setTheme(store.get("theme") === "light" ? "light" : "dark");

  if (firebaseConfig.apiKey.startsWith("COLE")) {
    $("#app").replaceChildren(h("section", { class: "welcome" }, h("h1", {}, "Falta configurar"),
      h("p", { class: "muted" }, "Cole o seu firebaseConfig no arquivo firebase-config.js.")));
    return;
  }

  const app = initializeApp(firebaseConfig);
  auth = getAuth(app);
  db = initializeFirestore(app, {
    localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
  });

  // O app só desenha a tela depois que o Firebase informa se há alguém logado.
  onAuthStateChanged(auth, (user) => {
    state.user = user;
    user ? subscribe() : unsubscribe();
    render();
  });

  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
}

init();
