// Limpa automaticamente todas as reservas ao carregar o projeto
localStorage.removeItem("reservas");

// Referências DOM
const loginBtn = document.getElementById("loginBtn");
const logoutBtn = document.getElementById("logoutBtn");
const reservaForm = document.getElementById("reservaForm");

// Simulação de usuário logado
let usuarioLogado = false;
let usuarioId = null; // ID do usuário logado

// Lista de reservas (sempre vazia no início)
let reservas = [];

// Intervalos de 30 minutos entre 08:00 e 17:00
function gerarHorarios() {
  let horarios = [];
  for (let h = 8; h < 17; h++) { // até 16:30
    horarios.push(`${String(h).padStart(2,"0")}:00`);
    horarios.push(`${String(h).padStart(2,"0")}:30`);
  }
  horarios.push("17:00"); // último horário permitido
  return horarios;
}

// Remove horários já reservados em uma data específica
function filtrarHorariosDisponiveis(dataSelecionada, horarios) {
  return horarios; // sempre todos disponíveis, pois iniciamos vazio
}

// Preenche selects de horários com horários disponíveis
function preencherHorarios() {
  const inicioSel = document.getElementById("inicio");
  const fimSel = document.getElementById("fim");
  const horarios = gerarHorarios();

  function atualizar() {
    const dataInicio = document.getElementById("dataInicio").value;
    if (!dataInicio) return;

    // Corrige problema de fuso horário
    const partes = dataInicio.split('-'); // "YYYY-MM-DD"
    const date = new Date(partes[0], partes[1] - 1, partes[2]);
    const diaSemana = date.getDay(); // 0 = domingo, 6 = sábado

    if (diaSemana === 0 || diaSemana === 6) {
      inicioSel.innerHTML = '';
      fimSel.innerHTML = '';
      alert("Só é permitido reservar de segunda a sexta-feira.");
      return;
    }

    const disponiveis = filtrarHorariosDisponiveis(date, horarios);
    inicioSel.innerHTML = '';
    fimSel.innerHTML = '';
    disponiveis.forEach(h => {
      inicioSel.innerHTML += `<option value="${h}">${h}</option>`;
      fimSel.innerHTML += `<option value="${h}">${h}</option>`;
    });
  }

  document.getElementById("dataInicio").addEventListener("change", atualizar);
  atualizar();
}
preencherHorarios();

// Login/Logout simulados
loginBtn.addEventListener("click", () => {
  usuarioLogado = true;
  usuarioId = Date.now().toString(); // gera um ID único temporário
  loginBtn.classList.add("d-none");
  logoutBtn.classList.remove("d-none");
  alert("Login simulado realizado!");
});

logoutBtn.addEventListener("click", () => {
  usuarioLogado = false;
  usuarioId = null;
  loginBtn.classList.remove("d-none");
  logoutBtn.classList.add("d-none");
  alert("Logout realizado!");
});

// Inicializa FullCalendar
document.addEventListener("DOMContentLoaded", function () {
  const calendarEl = document.getElementById("calendar");

  const calendar = new FullCalendar.Calendar(calendarEl, {
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
      day: "Dia",
      list: "Lista"
    },
    selectable: true,
    events: reservas.map(r => ({
      id: r.id,
      title: r.descricao,
      start: r.inicio,
      end: r.fim,
      extendedProps: { 
        usuarioId: r.usuarioId,
        nome: r.nome,
        setor: r.setor,
        telefone: r.telefone,
        email: r.email
      }
    })),
    eventClick: function(info) {
      const r = info.event;
      const detalhes = `
Descrição: ${r.title}
Nome: ${r.extendedProps.nome}
Setor: ${r.extendedProps.setor}
Telefone: ${r.extendedProps.telefone}
E-mail: ${r.extendedProps.email}
Início: ${r.start.toLocaleString()}
Fim: ${r.end.toLocaleString()}
      `;
      if (usuarioLogado && r.extendedProps.usuarioId === usuarioId) {
        if (confirm(`${detalhes}\n\nDeseja excluir sua reserva?`)) {
          reservas = reservas.filter(res => res.id !== r.id);
          localStorage.setItem("reservas", JSON.stringify(reservas));
          r.remove();
        }
      } else {
        alert(detalhes);
      }
    }
  });

  calendar.render();

  // Salvar reserva no localStorage
  reservaForm.addEventListener("submit", (e) => {
    e.preventDefault();

    if (!usuarioLogado) {
      alert("Faça login para reservar o auditório.");
      return;
    }

    const dataInicio = document.getElementById("dataInicio").value;
    const dataFim = document.getElementById("dataFim").value;
    const inicioHora = document.getElementById("inicio").value;
    const fimHora = document.getElementById("fim").value;

    const inicio = new Date(`${dataInicio}T${inicioHora}:00`);
    const fim = new Date(`${dataFim}T${fimHora}:00`);

    const novaReserva = {
      id: Date.now().toString(),
      usuarioId: usuarioId,
      nome: document.getElementById("nome").value,
      setor: document.getElementById("setor").value,
      telefone: document.getElementById("telefone").value,
      email: document.getElementById("email").value,
      descricao: document.getElementById("descricao").value,
      inicio: inicio.toISOString(),
      fim: fim.toISOString()
    };

    reservas.push(novaReserva);
    localStorage.setItem("reservas", JSON.stringify(reservas));
    reservaForm.reset();

    // Atualiza os horários disponíveis
    preencherHorarios();

    // Adiciona a nova reserva no calendário
    calendar.addEventSource([{
      id: novaReserva.id,
      title: novaReserva.descricao,
      start: novaReserva.inicio,
      end: novaReserva.fim,
      extendedProps: { 
        usuarioId: novaReserva.usuarioId,
        nome: novaReserva.nome,
        setor: novaReserva.setor,
        telefone: novaReserva.telefone,
        email: novaReserva.email
      }
    }]);
  });
});
