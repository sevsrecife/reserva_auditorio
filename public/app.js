const loginBtn = document.getElementById("loginBtn");
const logoutBtn = document.getElementById("logoutBtn");
const reservaForm = document.getElementById("reservaForm");
const userNameSpan = document.getElementById("userName");
const googleSignInContainer = document.getElementById("googleSignInContainer");
const reservaSucesso = document.getElementById("reservaSucesso");
const googleCalendarLink = document.getElementById("googleCalendarLink");
const modalDeleteActions = document.getElementById("modalDeleteActions");

const adminPanel = document.getElementById("adminPanel");
const toggleAdminAreaBtn = document.getElementById("toggleAdminAreaBtn");
const adminLoginForm = document.getElementById("adminLoginForm");
const adminArea = document.getElementById("adminArea");
const adminStatusText = document.getElementById("adminStatusText");
const adminReservasTableBody = document.querySelector("#adminReservasTable tbody");
const adminEditForm = document.getElementById("adminEditForm");

const divRecorrencia = document.getElementById("divRecorrencia");
const checkRecorrencia = document.getElementById("repetirSemanal");

let currentSession = null;
let calendar = null;
let googleClientId = "";
let googleInitialized = false;
let lastLoadedReservas = [];

document.addEventListener("DOMContentLoaded", async () => {
  try {
    await initializeGoogleConfig();
    configureScheduleInputs("inicio", "fim", "dataInicio");
    configureScheduleInputs("adminEditInicio", "adminEditFim", "adminEditData");
    initializeCalendar();
    bindEvents();
    await refreshSession();
    await loadReservas();
  } catch (error) {
    console.error(error);
    alert("Falha ao inicializar o sistema.");
  }
});

function bindEvents() {
  loginBtn.addEventListener("click", async () => {
    if (!googleClientId) {
      alert("Login Google indisponível. Verifique a configuração do sistema.");
      return;
    }
    if (!googleInitialized) {
      setupGoogleIdentity();
    }
    if (!googleInitialized) {
      alert("Biblioteca do Google ainda não carregou. Tente novamente em instantes.");
      return;
    }
    googleSignInContainer.classList.remove("d-none");
    window.google.accounts.id.prompt();
  });

  logoutBtn.addEventListener("click", async () => {
    try {
      await apiFetch("/api/auth/logout", { method: "POST" });
      currentSession = null;
      updateAuthUi();
      adminArea.classList.add("d-none");
      await loadReservas();
      alert("Logout realizado!");
    } catch (error) {
      console.error(error);
      alert(error.message || "Erro ao fazer logout.");
    }
  });

  reservaForm.addEventListener("submit", handleReservaSubmit);

  toggleAdminAreaBtn.addEventListener("click", () => {
    adminPanel.classList.toggle("d-none");
  });

  adminLoginForm.addEventListener("submit", handleAdminLoginSubmit);
  adminEditForm.addEventListener("submit", handleAdminEditSubmit);
}

async function initializeGoogleConfig() {
  const config = await apiFetch("/api/config");
  googleClientId = config.googleClientId;
  if (googleClientId) {
    setupGoogleIdentity();
  }
}

function setupGoogleIdentity() {
  if (googleInitialized || !window.google?.accounts?.id || !googleClientId) {
    return;
  }

  window.google.accounts.id.initialize({
    client_id: googleClientId,
    callback: async (response) => {
      try {
        await apiFetch("/api/auth/google", {
          method: "POST",
          body: JSON.stringify({ idToken: response.credential })
        });
        await refreshSession();
        await loadReservas();
        googleSignInContainer.classList.add("d-none");
        alert("Login com Google realizado com sucesso!");
      } catch (error) {
        console.error(error);
        alert(error.message || "Falha no login com Google.");
      }
    }
  });

  window.google.accounts.id.renderButton(googleSignInContainer, {
    type: "standard",
    shape: "rectangular",
    theme: "outline",
    text: "signin_with",
    size: "large"
  });

  googleInitialized = true;
}

async function refreshSession() {
  const session = await apiFetch("/api/session");
  currentSession = session.authenticated ? session : null;
  updateAuthUi();
}

function updateAuthUi() {
  const isAuthenticated = Boolean(currentSession?.authenticated);
  const isAdmin = currentSession?.role === "admin";

  loginBtn.classList.toggle("d-none", isAuthenticated);
  logoutBtn.classList.toggle("d-none", !isAuthenticated);
  userNameSpan.textContent = isAuthenticated
    ? `Olá, ${currentSession.user.name}!`
    : "";

  if (divRecorrencia) {
    divRecorrencia.classList.add("d-none");
  }
  if (checkRecorrencia) {
    checkRecorrencia.checked = false;
  }

  const emailField = document.getElementById("email");
  if (isAuthenticated && currentSession.user.email) {
    emailField.value = currentSession.user.email;
  }

  if (isAdmin) {
    adminArea.classList.remove("d-none");
    adminStatusText.textContent = "Sessão administrativa ativa.";
    loadAdminReservas();
  } else {
    adminArea.classList.add("d-none");
    adminStatusText.textContent = "";
  }
}

function initializeCalendar() {
  const calendarEl = document.getElementById("calendar");
  calendar = new FullCalendar.Calendar(calendarEl, {
    initialView: "dayGridMonth",
    locale: "pt-br",
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
    selectable: true,
    eventClick: onEventClick
  });
  calendar.render();
}

async function loadReservas() {
  const data = await apiFetch("/api/reservas");
  lastLoadedReservas = data.reservas || [];

  const events = lastLoadedReservas
    .filter((reserva) => reserva.status !== "cancelada")
    .map((reserva) => ({
      id: reserva.id,
      title: reserva.descricao,
      start: reserva.inicio_iso,
      end: reserva.fim_iso,
      extendedProps: {
        ownerGoogleId: reserva.owner_google_id,
        ownerName: reserva.owner_name,
        ownerEmail: reserva.owner_email,
        nome: reserva.nome,
        setor: reserva.setor,
        telefone: reserva.telefone,
        emailContato: reserva.email_contato,
        isImported: Boolean(reserva.is_imported)
      }
    }));

  calendar.removeAllEvents();
  calendar.addEventSource(events);
}

function onEventClick(info) {
  const event = info.event;
  const detalhes = `
Descrição: ${event.title}
Nome: ${event.extendedProps.nome}
Setor: ${event.extendedProps.setor}
Telefone: ${event.extendedProps.telefone}
E-mail: ${event.extendedProps.emailContato}
Início: ${event.start.toLocaleString("pt-BR")}
Fim: ${event.end.toLocaleString("pt-BR")}
Solicitante Google: ${event.extendedProps.ownerName}
  `;

  const isOwner = currentSession?.user?.id && event.extendedProps.ownerGoogleId === currentSession.user.id;
  const isAdmin = currentSession?.role === "admin";
  const isImportedReservation = Boolean(event.extendedProps.isImported);

  document.getElementById("modal-reserva-detalhes").textContent = detalhes;
  modalDeleteActions.classList.toggle("d-none", !((isOwner && !isImportedReservation) || isAdmin));

  const confirmDeleteModal = new bootstrap.Modal(document.getElementById("confirmDeleteModal"));
  confirmDeleteModal.show();

  const confirmBtn = document.getElementById("confirmDeleteBtn");
  const novoConfirmBtn = confirmBtn.cloneNode(true);
  confirmBtn.parentNode.replaceChild(novoConfirmBtn, confirmBtn);

  novoConfirmBtn.onclick = async () => {
    try {
      const route = isAdmin ? `/api/admin/reservas/${event.id}` : `/api/reservas/${event.id}`;
      await apiFetch(route, { method: "DELETE" });
      confirmDeleteModal.hide();
      await loadReservas();
      if (isAdmin) {
        await loadAdminReservas();
      }
      alert("Reserva excluída com sucesso!");
    } catch (error) {
      console.error(error);
      alert(error.message || "Falha ao excluir a reserva.");
    }
  };
}

async function handleReservaSubmit(e) {
  e.preventDefault();

  if (!currentSession?.authenticated) {
    alert("Faça login com Google para reservar o auditório.");
    return;
  }

  if (currentSession.role !== "user") {
    alert("A conta administrativa não pode criar reservas.");
    return;
  }

  const dataInicio = document.getElementById("dataInicio").value;
  const dataFim = document.getElementById("dataFim").value;
  const horaInicio = document.getElementById("inicio").value;
  const horaFim = document.getElementById("fim").value;

  if (!dataInicio || !dataFim || !horaInicio || !horaFim) {
    alert("Preencha data e horário corretamente.");
    return;
  }

  if (dataFim < dataInicio) {
    alert("A Data Limite deve ser igual ou posterior à Data de Início.");
    return;
  }

  const isRecorrente = Boolean(checkRecorrencia?.checked);
  if (isRecorrente) {
    alert("Reservas recorrentes não estão disponíveis neste fluxo.");
    return;
  }

  try {
    const payload = {
      nome: document.getElementById("nome").value,
      setor: document.getElementById("setor").value,
      telefone: document.getElementById("telefone").value,
      email: document.getElementById("email").value,
      descricao: document.getElementById("descricao").value,
      dataReserva: dataInicio,
      horaInicio,
      horaFim
    };

    const response = await apiFetch("/api/reservas", {
      method: "POST",
      body: JSON.stringify(payload)
    });

    reservaForm.reset();
    if (currentSession.user.email) {
      document.getElementById("email").value = currentSession.user.email;
    }
    showReservaSuccess(response.googleCalendarUrl);
    await loadReservas();
  } catch (error) {
    console.error(error);
    alert(error.message || "Erro ao criar reserva.");
  }
}

function showReservaSuccess(calendarUrl) {
  if (!calendarUrl) {
    reservaSucesso.classList.add("d-none");
    return;
  }
  googleCalendarLink.href = calendarUrl;
  reservaSucesso.classList.remove("d-none");
}

async function handleAdminLoginSubmit(e) {
  e.preventDefault();
  try {
    const username = document.getElementById("adminUsername").value;
    const password = document.getElementById("adminPassword").value;
    await apiFetch("/api/admin/login", {
      method: "POST",
      body: JSON.stringify({ username, password })
    });
    await refreshSession();
    await loadReservas();
    alert("Login administrativo realizado com sucesso.");
  } catch (error) {
    console.error(error);
    alert(error.message || "Falha no login administrativo.");
  }
}

async function loadAdminReservas() {
  if (currentSession?.role !== "admin") {
    return;
  }
  const data = await apiFetch("/api/admin/reservas");
  const reservas = data.reservas || [];

  adminReservasTableBody.innerHTML = "";
  for (const reserva of reservas) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${formatDate(reserva.data_reserva)}</td>
      <td>${reserva.hora_inicio} - ${reserva.hora_fim}</td>
      <td>${escapeHtml(reserva.descricao)}</td>
      <td>${escapeHtml(reserva.nome)}</td>
      <td>${escapeHtml(reserva.status)}</td>
      <td>
        <button type="button" class="btn btn-sm btn-outline-primary me-2" data-action="edit">Editar</button>
        <button type="button" class="btn btn-sm btn-outline-danger" data-action="delete">Excluir</button>
      </td>
    `;

    tr.querySelector('[data-action="edit"]').addEventListener("click", () => {
      fillAdminEditForm(reserva);
    });
    tr.querySelector('[data-action="delete"]').addEventListener("click", async () => {
      const confirmed = window.confirm("Deseja realmente excluir esta reserva?");
      if (!confirmed) {
        return;
      }
      try {
        await apiFetch(`/api/admin/reservas/${reserva.id}`, { method: "DELETE" });
        await loadAdminReservas();
        await loadReservas();
        alert("Reserva excluída com sucesso.");
      } catch (error) {
        console.error(error);
        alert(error.message || "Falha ao excluir reserva.");
      }
    });

    adminReservasTableBody.appendChild(tr);
  }
}

function fillAdminEditForm(reserva) {
  document.getElementById("adminEditId").value = reserva.id;
  document.getElementById("adminEditNome").value = reserva.nome;
  document.getElementById("adminEditSetor").value = reserva.setor;
  document.getElementById("adminEditTelefone").value = reserva.telefone;
  document.getElementById("adminEditEmail").value = reserva.email_contato;
  document.getElementById("adminEditDescricao").value = reserva.descricao;
  document.getElementById("adminEditData").value = reserva.data_reserva;
  document.getElementById("adminEditInicio").value = reserva.hora_inicio;
  document.getElementById("adminEditFim").value = reserva.hora_fim;
  document.getElementById("adminEditStatus").value = reserva.status;
}

async function handleAdminEditSubmit(e) {
  e.preventDefault();
  if (currentSession?.role !== "admin") {
    alert("Acesso administrativo não autorizado.");
    return;
  }

  const id = document.getElementById("adminEditId").value;
  if (!id) {
    alert("Selecione uma reserva para editar.");
    return;
  }

  try {
    await apiFetch(`/api/admin/reservas/${id}`, {
      method: "PUT",
      body: JSON.stringify({
        nome: document.getElementById("adminEditNome").value,
        setor: document.getElementById("adminEditSetor").value,
        telefone: document.getElementById("adminEditTelefone").value,
        email: document.getElementById("adminEditEmail").value,
        descricao: document.getElementById("adminEditDescricao").value,
        dataReserva: document.getElementById("adminEditData").value,
        horaInicio: document.getElementById("adminEditInicio").value,
        horaFim: document.getElementById("adminEditFim").value,
        status: document.getElementById("adminEditStatus").value
      })
    });
    await loadAdminReservas();
    await loadReservas();
    alert("Reserva atualizada com sucesso.");
  } catch (error) {
    console.error(error);
    alert(error.message || "Falha ao atualizar reserva.");
  }
}

function configureScheduleInputs(inicioId, fimId, dataId) {
  const inicioSel = document.getElementById(inicioId);
  const fimSel = document.getElementById(fimId);
  const dataInput = document.getElementById(dataId);
  const horarios = generateTimeOptions();

  inicioSel.innerHTML = "";
  fimSel.innerHTML = "";
  horarios.forEach((hora) => {
    inicioSel.innerHTML += `<option value="${hora}">${hora}</option>`;
    fimSel.innerHTML += `<option value="${hora}">${hora}</option>`;
  });

  dataInput.addEventListener("change", () => {
    const dataSelecionada = dataInput.value;
    if (!dataSelecionada) {
      return;
    }
    const [ano, mes, dia] = dataSelecionada.split("-").map(Number);
    const date = new Date(ano, mes - 1, dia);
    const diaSemana = date.getDay();
    if (diaSemana === 0 || diaSemana === 6) {
      alert("Só é permitido reservar de segunda a sexta-feira.");
      dataInput.value = "";
    }
  });
}

function generateTimeOptions() {
  const horarios = [];
  for (let h = 8; h < 17; h += 1) {
    horarios.push(`${String(h).padStart(2, "0")}:00`);
    horarios.push(`${String(h).padStart(2, "0")}:30`);
  }
  horarios.push("17:00");
  return horarios;
}

function formatDate(value) {
  if (!value) {
    return "";
  }
  const [year, month, day] = value.split("-");
  return `${day}/${month}/${year}`;
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

async function apiFetch(path, options = {}) {
  const response = await fetch(path, {
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
    throw new Error(data.error || "Falha na operação.");
  }
  return data;
}
