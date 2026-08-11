const appConfig = window.__APP_CONFIG__ || {};
const API_BASE_URL = String(appConfig.apiBaseUrl || "").replace(/\/$/, "") || window.location.origin;

const els = {
  loginBtn: document.getElementById("loginBtn"),
  logoutBtn: document.getElementById("logoutBtn"),
  toggleAdminAreaBtn: document.getElementById("toggleAdminAreaBtn"),
  authIdentity: document.getElementById("authIdentity"),
  authEmail: document.getElementById("authEmail"),
  authRoleBadge: document.getElementById("authRoleBadge"),
  googleSignInContainer: document.getElementById("googleSignInContainer"),
  appFeedback: document.getElementById("appFeedback"),
  reservaForm: document.getElementById("reservaForm"),
  reservaSubmitBtn: document.getElementById("submitReservaBtn"),
  reservaSuccessModal: new bootstrap.Modal(document.getElementById("reservationSuccessModal")),
  reservationSuccessBody: document.getElementById("reservationSuccessBody"),
  successCalendarLink: document.getElementById("successCalendarLink"),
  successEmailLink: document.getElementById("successEmailLink"),
  copyReservationBtn: document.getElementById("copyReservationBtn"),
  reservationDetailModal: new bootstrap.Modal(document.getElementById("reservationDetailModal")),
  reservationDetailBody: document.getElementById("reservationDetailBody"),
  detailCalendarLink: document.getElementById("detailCalendarLink"),
  detailEmailLink: document.getElementById("detailEmailLink"),
  detailDeleteBtn: document.getElementById("detailDeleteBtn"),
  calendarEl: document.getElementById("calendar"),
  adminPanel: document.getElementById("adminPanel"),
  adminLoginForm: document.getElementById("adminLoginForm"),
  adminArea: document.getElementById("adminArea"),
  adminStatusText: document.getElementById("adminStatusText"),
  adminReservasTableBody: document.querySelector("#adminReservasTable tbody"),
  adminEditForm: document.getElementById("adminEditForm"),
  recurrencePattern: document.getElementById("recurrencePattern"),
  recurrenceWeekdaysWrap: document.getElementById("recurrenceWeekdaysWrap"),
  recurrenceWeekdays: [...document.querySelectorAll(".recurrence-weekday")],
  adminLoginUsername: document.getElementById("adminUsername"),
  adminLoginPassword: document.getElementById("adminPassword")
};

const state = {
  calendar: null,
  currentSession: null,
  googleClientId: "",
  googleInitialized: false,
  lastLoadedReservas: [],
  lastSuccessPayload: null,
  busy: false
};

document.addEventListener("DOMContentLoaded", async () => {
  bindEvents();
  configureTimeSelects();
  configureDateGuards("dataInicio");
  configureDateGuards("dataFim");
  configureDateGuards("adminEditData");

  try {
    await loadConfig();
    setupCalendar();
    await refreshSession();
    await loadReservas();
  } catch (error) {
    console.error(error);
    showFeedback(error.message || "Falha ao inicializar o sistema.", "danger");
  }
});

function bindEvents() {
  els.loginBtn.addEventListener("click", handleLoginClick);
  els.logoutBtn.addEventListener("click", handleLogoutClick);
  els.toggleAdminAreaBtn.addEventListener("click", () => {
    els.adminPanel.classList.toggle("d-none");
  });
  els.reservaForm.addEventListener("submit", handleReservaSubmit);
  els.adminLoginForm.addEventListener("submit", handleAdminLoginSubmit);
  els.adminEditForm.addEventListener("submit", handleAdminEditSubmit);
  els.recurrencePattern.addEventListener("change", syncRecurrenceUi);
  document.getElementById("dataInicio").addEventListener("change", syncSingleDateEnd);
  els.copyReservationBtn.addEventListener("click", copySuccessDetails);
  els.detailDeleteBtn.addEventListener("click", deleteSelectedReservation);
}

async function loadConfig() {
  const config = await apiFetch("/api/config", { skipAuth: true });
  state.googleClientId = config.googleClientId || "";
  if (state.googleClientId && window.google?.accounts?.id) {
    setupGoogleIdentity();
  }
}

function setupCalendar() {
  state.calendar = new FullCalendar.Calendar(els.calendarEl, {
    initialView: "dayGridMonth",
    locale: "pt-br",
    height: "auto",
    expandRows: true,
    selectable: false,
    headerToolbar: {
      left: "prev,next today",
      center: "title",
      right: "dayGridMonth,timeGridWeek,timeGridDay"
    },
    buttonText: {
      today: "Hoje",
      month: "Mês",
      week: "Semana",
      day: "Dia"
    },
    eventClick: onEventClick
  });
  state.calendar.render();
}

async function refreshSession() {
  const session = await apiFetch("/api/session", { skipAuth: true });
  state.currentSession = session.authenticated ? session : null;
  syncSessionUi();
}

function syncSessionUi() {
  const session = state.currentSession;
  const isAuthenticated = Boolean(session?.authenticated);
  const isAdmin = session?.role === "admin";

  els.loginBtn.classList.toggle("d-none", isAuthenticated);
  els.logoutBtn.classList.toggle("d-none", !isAuthenticated);
  els.authIdentity.textContent = isAuthenticated ? session.user.name : "Não autenticado";
  els.authEmail.textContent = isAuthenticated ? session.user.email : "";
  els.authRoleBadge.textContent = isAuthenticated ? (isAdmin ? "Administrador" : "Usuário autenticado") : "Visitante";
  els.authRoleBadge.className = `badge ${isAdmin ? "text-bg-dark" : isAuthenticated ? "text-bg-success" : "text-bg-secondary"}`;

  const nome = document.getElementById("nome");
  const email = document.getElementById("email");
  if (isAuthenticated) {
    nome.value = session.user.name || "";
    email.value = session.user.email || "";
    nome.readOnly = true;
    email.readOnly = true;
  } else {
    nome.readOnly = false;
    email.readOnly = false;
    els.reservaForm.reset();
  }

  els.reservaSubmitBtn.disabled = !isAuthenticated || isAdmin;
  els.reservaSubmitBtn.textContent = isAdmin
    ? "Administrador não pode criar reservas"
    : "Registrar reserva";

  if (isAdmin) {
    els.adminPanel.classList.remove("d-none");
  }
  els.adminLoginForm.classList.toggle("d-none", isAdmin);
  els.adminArea.classList.toggle("d-none", !isAdmin);
  els.adminStatusText.textContent = isAdmin
    ? `Sessão administrativa ativa: ${session.user.name} (${session.user.email}).`
    : "";

  if (isAdmin) {
    loadAdminReservas();
  }
}

async function handleLoginClick() {
  if (!state.googleClientId) {
    showFeedback("Login Google indisponível. Verifique a configuração do servidor.", "danger");
    return;
  }

  if (!state.googleInitialized) {
    setupGoogleIdentity();
  }

  if (!state.googleInitialized) {
    showFeedback("A biblioteca do Google ainda não carregou. Tente novamente.", "warning");
    return;
  }

  els.googleSignInContainer.classList.remove("d-none");
  window.google.accounts.id.prompt();
}

function setupGoogleIdentity() {
  if (state.googleInitialized || !window.google?.accounts?.id || !state.googleClientId) {
    return;
  }

  window.google.accounts.id.initialize({
    client_id: state.googleClientId,
    callback: async (response) => {
      try {
        await apiFetch("/api/auth/google", {
          method: "POST",
          body: JSON.stringify({ idToken: response.credential })
        });
        showFeedback("Login com Google realizado com sucesso.", "success");
        await refreshSession();
        await loadReservas();
        els.googleSignInContainer.classList.add("d-none");
      } catch (error) {
        console.error(error);
        showFeedback(error.message || "Falha no login com Google.", "danger");
      }
    }
  });

  window.google.accounts.id.renderButton(els.googleSignInContainer, {
    type: "standard",
    shape: "rectangular",
    theme: "outline",
    text: "signin_with",
    size: "large",
    logo_alignment: "left"
  });

  state.googleInitialized = true;
}

async function handleLogoutClick() {
  try {
    await apiFetch("/api/auth/logout", { method: "POST" });
    state.currentSession = null;
    state.lastLoadedReservas = [];
    state.lastSuccessPayload = null;
    els.reservaForm.reset();
    syncRecurrenceUi();
    syncSessionUi();
    await loadReservas();
    showFeedback("Logout realizado com sucesso.", "success");
  } catch (error) {
    console.error(error);
    showFeedback(error.message || "Erro ao fazer logout.", "danger");
  }
}

async function loadReservas() {
  if (!state.currentSession?.authenticated) {
    state.calendar?.removeAllEvents();
    return;
  }

  const data = await apiFetch("/api/reservas");
  state.lastLoadedReservas = data.reservas || [];

  const events = state.lastLoadedReservas.map((reserva) => ({
    id: reserva.id,
    title: reserva.descricao,
    start: reserva.inicioIso,
    end: reserva.fimIso,
    backgroundColor: reserva.isImported ? "#6c757d" : "#db6605",
    borderColor: reserva.isImported ? "#6c757d" : "#db6605",
    extendedProps: reserva
  }));

  state.calendar.removeAllEvents();
  state.calendar.addEventSource(events);
}

function onEventClick(info) {
  const reserva = info.event.extendedProps;
  const isAdmin = state.currentSession?.role === "admin";
  const canDelete = isAdmin || Boolean(reserva.canDelete);

  renderReservationDetails(reserva, els.reservationDetailBody, isAdmin);
  els.detailCalendarLink.href = reserva.googleCalendarUrl || buildCalendarUrl(reserva);
  els.detailEmailLink.href = buildMailtoUrl(reserva);
  els.detailDeleteBtn.classList.toggle("d-none", !canDelete);
  els.detailDeleteBtn.dataset.reservationId = reserva.id;

  els.reservationDetailModal.show();
}

function renderReservationDetails(reserva, container, isAdmin) {
  const items = [
    ["Descrição", reserva.descricao],
    ["Responsável", reserva.ownerName || reserva.nome],
    ["E-mail", isAdmin ? reserva.ownerEmail || reserva.emailContato : reserva.emailContato],
    ["Setor", reserva.setor],
    ["Telefone", reserva.telefone],
    ["Data", formatDate(reserva.dataReserva)],
    ["Horário", `${reserva.horaInicio} - ${reserva.horaFim}`],
    ["Status", reserva.status],
    ["Origem", reserva.isImported ? "Backup importado" : "Manual"],
    ["Recorrência", formatRecurrenceLabel(reserva)]
  ];

  container.innerHTML = items
    .filter(([, value]) => value)
    .map(([label, value]) => `
      <div class="detail-row">
        <div class="detail-label">${escapeHtml(label)}</div>
        <div class="detail-value">${escapeHtml(value)}</div>
      </div>
    `)
    .join("");
}

async function deleteSelectedReservation() {
  const reservationId = els.detailDeleteBtn.dataset.reservationId;
  if (!reservationId) {
    return;
  }

  if (!window.confirm("Deseja realmente excluir esta reserva?")) {
    return;
  }

  try {
    await apiFetch(`/api/reservas/${reservationId}`, { method: "DELETE" });
    els.reservationDetailModal.hide();
    showFeedback("Reserva excluída com sucesso.", "success");
    await loadReservas();
    if (state.currentSession?.role === "admin") {
      await loadAdminReservas();
    }
  } catch (error) {
    console.error(error);
    showFeedback(error.message || "Falha ao excluir a reserva.", "danger");
  }
}

async function handleReservaSubmit(event) {
  event.preventDefault();

  if (!state.currentSession?.authenticated) {
    showFeedback("Faça login com Google para reservar o auditório.", "warning");
    return;
  }

  if (state.currentSession.role !== "user") {
    showFeedback("A conta administrativa não pode criar reservas.", "warning");
    return;
  }

  const payload = buildReservaPayload();
  if (!payload) {
    return;
  }

  try {
    setBusy(true);
    const response = await apiFetch("/api/reservas", {
      method: "POST",
      body: JSON.stringify(payload)
    });

    state.lastSuccessPayload = response;
    renderSuccessModal(response);
    els.reservaSuccessModal.show();
    els.reservaForm.reset();
    syncSessionUi();
    await loadReservas();
    showFeedback(response.message || "Reserva registrada com sucesso.", "success");
  } catch (error) {
    console.error(error);
    if (error.conflicts?.length) {
      showFeedback(formatConflictMessage(error.conflicts), "danger", true);
    } else {
      showFeedback(error.message || "Erro ao criar reserva.", "danger");
    }
  } finally {
    setBusy(false);
  }
}

function buildReservaPayload() {
  const dataInicio = document.getElementById("dataInicio").value;
  const dataFim = document.getElementById("dataFim").value;
  const horaInicio = document.getElementById("inicio").value;
  const horaFim = document.getElementById("fim").value;
  const nome = document.getElementById("nome").value.trim();
  const setor = document.getElementById("setor").value.trim();
  const telefone = document.getElementById("telefone").value.trim();
  const email = document.getElementById("email").value.trim();
  const descricao = document.getElementById("descricao").value.trim();
  const inviteEmails = document.getElementById("inviteEmails").value.trim();
  const recurrencePattern = els.recurrencePattern.value;

  if (!dataInicio || !dataFim || !horaInicio || !horaFim || !nome || !setor || !telefone || !email || !descricao) {
    showFeedback("Preencha todos os campos obrigatórios.", "warning");
    return null;
  }

  if (compareDates(dataFim, dataInicio) < 0) {
    showFeedback("A data final precisa ser igual ou posterior à data inicial.", "warning");
    return null;
  }

  const recurrenceWeekdays = recurrencePattern === "weekly"
    ? els.recurrenceWeekdays.filter((checkbox) => checkbox.checked).map((checkbox) => Number(checkbox.value))
    : [];

  return {
    nome,
    setor,
    telefone,
    email,
    descricao,
    dataInicio,
    dataFim,
    horaInicio,
    horaFim,
    recurrencePattern,
    recurrenceWeekdays,
    inviteEmails
  };
}

function renderSuccessModal(response) {
  const reservation = response.reservation || response.reservations?.[0];
  if (!reservation) {
    return;
  }

  els.reservationSuccessBody.innerHTML = [
    ["Responsável", reservation.ownerName || reservation.nome],
    ["E-mail", reservation.ownerEmail || reservation.emailContato],
    ["Data", formatDate(reservation.dataReserva)],
    ["Horário", `${reservation.horaInicio} - ${reservation.horaFim}`],
    ["Descrição", reservation.descricao],
    ["ID", reservation.id],
    ["Série", reservation.recurrenceSeriesId || "Reserva única"],
    ["Quantidade", String(response.reservations?.length || 1)]
  ]
    .map(([label, value]) => `
      <div class="detail-row">
        <div class="detail-label">${escapeHtml(label)}</div>
        <div class="detail-value">${escapeHtml(value)}</div>
      </div>
    `)
    .join("");

  const calendarUrl = response.googleCalendarUrl || buildCalendarUrl(reservation);
  const emailUrl = response.shareEmailUrl || buildMailtoUrl(reservation);
  els.successCalendarLink.href = calendarUrl;
  els.successEmailLink.href = emailUrl;
  els.copyReservationBtn.dataset.payload = JSON.stringify({
    ...reservation,
    googleCalendarUrl: calendarUrl,
    shareEmailUrl: emailUrl
  });
}

async function copySuccessDetails() {
  const raw = els.copyReservationBtn.dataset.payload;
  if (!raw) {
    return;
  }

  const reservation = JSON.parse(raw);
  const text = [
    `Responsável: ${reservation.ownerName || reservation.nome}`,
    `E-mail: ${reservation.ownerEmail || reservation.emailContato}`,
    `Data: ${formatDate(reservation.dataReserva)}`,
    `Horário: ${reservation.horaInicio} - ${reservation.horaFim}`,
    `Descrição: ${reservation.descricao}`,
    `ID: ${reservation.id}`,
    `Google Calendar: ${reservation.googleCalendarUrl || ""}`
  ].join("\n");

  await navigator.clipboard.writeText(text);
  showFeedback("Detalhes copiados para a área de transferência.", "success");
}

function formatConflictMessage(conflicts) {
  const dates = conflicts
    .map((conflict) => `${formatDate(conflict.dataReserva)} ${conflict.inicio} - ${conflict.fim}`)
    .join("; ");
  return `Conflito(s) de horário encontrado(s): ${dates}`;
}

async function handleAdminLoginSubmit(event) {
  event.preventDefault();
  try {
    setBusy(true);
    await apiFetch("/api/admin/login", {
      method: "POST",
      body: JSON.stringify({
        username: els.adminLoginUsername.value,
        password: els.adminLoginPassword.value
      })
    });
    els.adminLoginPassword.value = "";
    showFeedback("Login administrativo realizado com sucesso.", "success");
    await refreshSession();
    await loadReservas();
    await loadAdminReservas();
  } catch (error) {
    console.error(error);
    showFeedback(error.message || "Falha no login administrativo.", "danger");
  } finally {
    setBusy(false);
  }
}

async function loadAdminReservas() {
  if (state.currentSession?.role !== "admin") {
    return;
  }

  const data = await apiFetch("/api/admin/reservas");
  const reservas = data.reservas || [];
  els.adminReservasTableBody.innerHTML = "";

  for (const reserva of reservas) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${escapeHtml(formatDate(reserva.dataReserva))}</td>
      <td>${escapeHtml(reserva.horaInicio)} - ${escapeHtml(reserva.horaFim)}</td>
      <td>${escapeHtml(reserva.descricao)}</td>
      <td>${escapeHtml(reserva.ownerName || reserva.nome)}</td>
      <td>${escapeHtml(reserva.ownerEmail || reserva.emailContato)}</td>
      <td>${escapeHtml(reserva.isImported ? "Backup" : "Manual")}</td>
      <td>${escapeHtml(reserva.status)}</td>
      <td class="text-nowrap">
        <button type="button" class="btn btn-sm btn-outline-primary me-2" data-action="edit">Editar</button>
        <button type="button" class="btn btn-sm btn-outline-danger" data-action="delete">Excluir</button>
      </td>
    `;

    tr.querySelector('[data-action="edit"]').addEventListener("click", () => fillAdminEditForm(reserva));
    tr.querySelector('[data-action="delete"]').addEventListener("click", async () => {
      if (!window.confirm("Deseja realmente excluir esta reserva?")) {
        return;
      }
      try {
        await apiFetch(`/api/admin/reservas/${reserva.id}`, { method: "DELETE" });
        showFeedback("Reserva excluída com sucesso.", "success");
        await loadAdminReservas();
        await loadReservas();
      } catch (error) {
        console.error(error);
        showFeedback(error.message || "Falha ao excluir reserva.", "danger");
      }
    });

    els.adminReservasTableBody.appendChild(tr);
  }
}

function fillAdminEditForm(reserva) {
  document.getElementById("adminEditId").value = reserva.id;
  document.getElementById("adminEditSeriesId").value = reserva.recurrenceSeriesId || "";
  document.getElementById("adminEditNome").value = reserva.nome;
  document.getElementById("adminEditEmail").value = reserva.emailContato || reserva.ownerEmail || "";
  document.getElementById("adminEditSetor").value = reserva.setor;
  document.getElementById("adminEditTelefone").value = reserva.telefone;
  document.getElementById("adminEditDescricao").value = reserva.descricao;
  document.getElementById("adminEditData").value = reserva.dataReserva;
  document.getElementById("adminEditInicio").value = reserva.horaInicio;
  document.getElementById("adminEditFim").value = reserva.horaFim;
  document.getElementById("adminEditStatus").value = reserva.status;
  showFeedback("Reserva carregada para edição.", "info");
}

async function handleAdminEditSubmit(event) {
  event.preventDefault();
  if (state.currentSession?.role !== "admin") {
    showFeedback("Acesso administrativo não autorizado.", "danger");
    return;
  }

  const id = document.getElementById("adminEditId").value;
  if (!id) {
    showFeedback("Selecione uma reserva para editar.", "warning");
    return;
  }

  try {
    setBusy(true);
    await apiFetch(`/api/admin/reservas/${id}`, {
      method: "PUT",
      body: JSON.stringify({
        nome: document.getElementById("adminEditNome").value,
        email: document.getElementById("adminEditEmail").value,
        setor: document.getElementById("adminEditSetor").value,
        telefone: document.getElementById("adminEditTelefone").value,
        descricao: document.getElementById("adminEditDescricao").value,
        dataReserva: document.getElementById("adminEditData").value,
        horaInicio: document.getElementById("adminEditInicio").value,
        horaFim: document.getElementById("adminEditFim").value,
        status: document.getElementById("adminEditStatus").value
      })
    });
    showFeedback("Reserva atualizada com sucesso.", "success");
    await loadAdminReservas();
    await loadReservas();
  } catch (error) {
    console.error(error);
    if (error.conflicts?.length) {
      showFeedback(formatConflictMessage(error.conflicts), "danger", true);
    } else {
      showFeedback(error.message || "Falha ao atualizar reserva.", "danger");
    }
  } finally {
    setBusy(false);
  }
}

function configureTimeSelects() {
  const startSelects = [document.getElementById("inicio"), document.getElementById("adminEditInicio")];
  const endSelects = [document.getElementById("fim"), document.getElementById("adminEditFim")];
  const startOptions = generateTimeOptions(false);
  const endOptions = generateTimeOptions(true);

  for (const select of startSelects) {
    select.innerHTML = startOptions.map((time) => `<option value="${time}">${time}</option>`).join("");
  }

  for (const select of endSelects) {
    select.innerHTML = endOptions.map((time) => `<option value="${time}">${time}</option>`).join("");
  }

  document.getElementById("inicio").value = "08:00";
  document.getElementById("fim").value = "09:00";
  document.getElementById("adminEditInicio").value = "08:00";
  document.getElementById("adminEditFim").value = "09:00";
}

function generateTimeOptions(includeEnd = false) {
  const times = [];
  for (let hour = 8; hour <= 16; hour += 1) {
    times.push(`${String(hour).padStart(2, "0")}:00`);
    times.push(`${String(hour).padStart(2, "0")}:30`);
  }
  if (includeEnd) {
    times.push("17:00");
  }
  return includeEnd ? times : times.filter((time) => time !== "17:00");
}

function syncRecurrenceUi() {
  const pattern = els.recurrencePattern.value;
  els.recurrenceWeekdaysWrap.classList.toggle("d-none", pattern !== "weekly");
  if (pattern === "single") {
    syncSingleDateEnd();
  }
}

function syncSingleDateEnd() {
  if (els.recurrencePattern.value !== "single") {
    return;
  }
  const dataInicio = document.getElementById("dataInicio").value;
  document.getElementById("dataFim").value = dataInicio;
}

function configureDateGuards(id) {
  const input = document.getElementById(id);
  input.addEventListener("change", () => {
    if (!input.value) {
      return;
    }
    if (!isWeekday(input.value)) {
      showFeedback("Só é permitido reservar de segunda a sexta-feira.", "warning");
      input.value = "";
      return;
    }
    if (id === "dataInicio" && els.recurrencePattern.value === "single") {
      syncSingleDateEnd();
    }
  });
}

function setBusy(isBusy) {
  state.busy = isBusy;
  els.reservaSubmitBtn.disabled = isBusy || !state.currentSession?.authenticated || state.currentSession?.role === "admin";
  document.querySelectorAll("#adminLoginForm button, #adminEditForm button").forEach((button) => {
    button.disabled = isBusy;
  });
}

function showFeedback(message, type = "success", sticky = false) {
  els.appFeedback.className = `alert alert-${type} ${sticky ? "" : "fade-in"} mt-3`;
  els.appFeedback.textContent = message;
  els.appFeedback.classList.remove("d-none");

  if (!sticky) {
    window.clearTimeout(showFeedback._timer);
    showFeedback._timer = window.setTimeout(() => {
      els.appFeedback.classList.add("d-none");
    }, 5000);
  }
}

function buildCalendarUrl(reserva) {
  const startIso = reserva.inicioIso || buildLocalIso(reserva.dataReserva, reserva.horaInicio);
  const endIso = reserva.fimIso || buildLocalIso(reserva.dataReserva, reserva.horaFim);
  const params = new URLSearchParams({
    action: "TEMPLATE",
    text: reserva.descricao || "Reserva do auditório",
    dates: `${formatGoogleDate(startIso)}/${formatGoogleDate(endIso)}`,
    details: `Responsável: ${reserva.ownerName || reserva.nome}\nE-mail: ${reserva.ownerEmail || reserva.emailContato || ""}\nSetor: ${reserva.setor || ""}`,
    location: "Auditório"
  });

  if (Array.isArray(reserva.inviteEmails) && reserva.inviteEmails.length) {
    params.set("add", reserva.inviteEmails.join(","));
  }

  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

function buildMailtoUrl(reserva) {
  const subject = encodeURIComponent(`Reserva do auditório: ${reserva.descricao || ""}`);
  const body = encodeURIComponent(
    [
      `Reserva registrada no sistema de auditório.`,
      `Responsável: ${reserva.ownerName || reserva.nome}`,
      `E-mail: ${reserva.ownerEmail || reserva.emailContato || ""}`,
      `Setor: ${reserva.setor || ""}`,
      `Data: ${formatDate(reserva.dataReserva)}`,
      `Horário: ${reserva.horaInicio} - ${reserva.horaFim}`,
      `Descrição: ${reserva.descricao || ""}`,
      `ID: ${reserva.id || ""}`,
      `Google Calendar: ${reserva.googleCalendarUrl || buildCalendarUrl(reserva)}`
    ].join("\n")
  );
  return `mailto:?subject=${subject}&body=${body}`;
}

function formatRecurrenceLabel(reserva) {
  const pattern = reserva.recurrencePattern || "single";
  const labels = {
    single: "Reserva única",
    daily: "Diária",
    weekly: "Semanal",
    monthly: "Mensal"
  };
  const base = labels[pattern] || pattern;
  if (pattern === "weekly" && Array.isArray(reserva.recurrenceWeekdays) && reserva.recurrenceWeekdays.length) {
    return `${base} (${reserva.recurrenceWeekdays.join(", ")})`;
  }
  return base;
}

function formatDate(value) {
  if (!value) {
    return "";
  }
  const [year, month, day] = value.split("-");
  return `${day}/${month}/${year}`;
}

function formatGoogleDate(isoDate) {
  return new Date(isoDate).toISOString().replace(/[-:]/g, "").replace(".000", "");
}

function buildLocalIso(date, time) {
  return new Date(`${date}T${time}:00-03:00`).toISOString();
}

function compareDates(a, b) {
  return a.localeCompare(b);
}

function isWeekday(dateValue) {
  const date = new Date(`${dateValue}T00:00:00-03:00`);
  const weekday = date.getUTCDay();
  return weekday >= 1 && weekday <= 5;
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

async function apiFetch(path, options = {}) {
  const response = await fetch(buildApiUrl(path), {
    method: options.method || "GET",
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {})
    },
    credentials: "include",
    body: options.body
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || data.message || "Falha na operação.");
    if (data.conflicts) {
      error.conflicts = data.conflicts;
    }
    throw error;
  }
  return data;
}

function buildApiUrl(path) {
  if (/^https?:\/\//i.test(path)) {
    return path;
  }
  return `${API_BASE_URL}${path.startsWith("/") ? path : `/${path}`}`;
}
