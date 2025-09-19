import { initializeApp } from "https://www.gstatic.com/firebasejs/9.6.10/firebase-app.js";
import { getFirestore, collection, onSnapshot, addDoc, deleteDoc, doc, Timestamp } from "https://www.gstatic.com/firebasejs/9.6.10/firebase-firestore.js";
import { getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/9.6.10/firebase-auth.js";


// Configurações do Firebase
const firebaseConfig = {
    apiKey: "AIzaSyBDLGYMfiBFnzp4KZSvN556CEneFDN75NI",
    authDomain: "reserva-auditorio-c4ed1.firebaseapp.com",
    projectId: "reserva-auditorio-c4ed1",
    storageBucket: "reserva-auditorio-c4ed1.firebasestorage.app",
    messagingSenderId: "457665964653",
    appId: "1:457665964653:web:fce0c24e330d7906b3ad64"
};

// Inicializa Firebase
const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);
const provider = new GoogleAuthProvider();

// Referências DOM
const loginBtn = document.getElementById("loginBtn");
const logoutBtn = document.getElementById("logoutBtn");
const reservaForm = document.getElementById("reservaForm");
const userNameSpan = document.getElementById("userName");

// Estado do usuário
let usuarioLogado = null; // Objeto de usuário do Firebase
let usuarioId = null;

// Listeners de autenticação
loginBtn.addEventListener("click", () => {
    signInWithPopup(auth, provider)
        .then((result) => {
            alert("Login com Google realizado com sucesso!");
        })
        .catch((error) => {
            console.error("Erro no login:", error);
            alert("Falha no login. Tente novamente.");
        });
});

logoutBtn.addEventListener("click", () => {
    signOut(auth).then(() => {
        alert("Logout realizado!");
    }).catch((error) => {
        console.error("Erro no logout:", error);
    });
});

onAuthStateChanged(auth, (user) => {
    if (user) {
        usuarioLogado = user;
        usuarioId = user.uid;
        loginBtn.classList.add("d-none");
        logoutBtn.classList.remove("d-none");
        userNameSpan.textContent = `Olá, ${user.displayName}!`;
    } else {
        usuarioLogado = null;
        usuarioId = null;
        loginBtn.classList.remove("d-none");
        logoutBtn.classList.add("d-none");
        userNameSpan.textContent = '';
    }
});

// Inicializa FullCalendar e ouvinte do Firestore
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
            day: "Dia"
        },
        selectable: true,
        eventClick: function (info) {
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
            if (usuarioId && r.extendedProps.usuarioId === usuarioId) {
                if (confirm(`${detalhes}\n\nDeseja excluir sua reserva?`)) {
                    deleteDoc(doc(db, "reservas", r.id))
                        .then(() => {
                            alert("Reserva excluída com sucesso!");
                        })
                        .catch((error) => {
                            console.error("Erro ao excluir reserva:", error);
                            alert("Falha ao excluir a reserva.");
                        });
                }
            } else {
                alert(detalhes);
            }
        }
    });
    calendar.render();

    // Ouvinte em tempo real para o Firestore
    onSnapshot(collection(db, "reservas"), (querySnapshot) => {
        const reservas = [];
        querySnapshot.forEach((doc) => {
            const data = doc.data();
            reservas.push({
                id: doc.id,
                title: data.descricao,
                start: data.inicio.toDate(),
                end: data.fim.toDate(),
                extendedProps: {
                    usuarioId: data.usuarioId,
                    nome: data.nome,
                    setor: data.setor,
                    telefone: data.telefone,
                    email: data.email
                }
            });
        });
        calendar.removeAllEvents();
        calendar.addEventSource(reservas);
    });

    // Submissão do formulário de reserva
    reservaForm.addEventListener("submit", (e) => {
        e.preventDefault();

        if (!usuarioId) {
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
            usuarioId: usuarioId,
            nome: document.getElementById("nome").value,
            setor: document.getElementById("setor").value,
            telefone: document.getElementById("telefone").value,
            email: document.getElementById("email").value,
            descricao: document.getElementById("descricao").value,
            inicio: Timestamp.fromDate(inicio),
            fim: Timestamp.fromDate(fim)
        };

        addDoc(collection(db, "reservas"), novaReserva)
            .then(() => {
                alert("Reserva criada com sucesso!");
                reservaForm.reset();
            })
            .catch((error) => {
                console.error("Erro ao adicionar reserva:", error);
                alert("Falha ao criar a reserva.");
            });
    });

    // Funções de horários (mantidas)
    function gerarHorarios() {
        let horarios = [];
        for (let h = 8; h < 17; h++) {
            horarios.push(`${String(h).padStart(2, "0")}:00`);
            horarios.push(`${String(h).padStart(2, "0")}:30`);
        }
        horarios.push("17:00");
        return horarios;
    }

    function preencherHorarios() {
        const inicioSel = document.getElementById("inicio");
        const fimSel = document.getElementById("fim");
        const horarios = gerarHorarios();

        function atualizar() {
            const dataInicio = document.getElementById("dataInicio").value;
            if (!dataInicio) return;

            const partes = dataInicio.split('-');
            const date = new Date(partes[0], partes[1] - 1, partes[2]);
            const diaSemana = date.getDay();

            if (diaSemana === 0 || diaSemana === 6) {
                inicioSel.innerHTML = '';
                fimSel.innerHTML = '';
                alert("Só é permitido reservar de segunda a sexta-feira.");
                return;
            }

            inicioSel.innerHTML = '';
            fimSel.innerHTML = '';
            horarios.forEach(h => {
                inicioSel.innerHTML += `<option value="${h}">${h}</option>`;
                fimSel.innerHTML += `<option value="${h}">${h}</option>`;
            });
        }

        document.getElementById("dataInicio").addEventListener("change", atualizar);
        atualizar();
    }
    preencherHorarios();
});