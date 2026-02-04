import { initializeApp } from "https://www.gstatic.com/firebasejs/9.6.10/firebase-app.js";
import { getFirestore, collection, onSnapshot, addDoc, deleteDoc, doc, Timestamp, getDocs } from "https://www.gstatic.com/firebasejs/9.6.10/firebase-firestore.js";
import { getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/9.6.10/firebase-auth.js";

// ==========================================
// CONFIGURAÇÃO DO ADMINISTRADOR
// ==========================================
const EMAIL_ADMIN = "cpazzola.sevsrecife@gmail.com"; 

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

// Referências DOM da Recorrência
const divRecorrencia = document.getElementById("divRecorrencia");
const checkRecorrencia = document.getElementById("repetirSemanal");

// Estado do usuário
let usuarioLogado = null;
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

// Listener de mudança de estado (Login/Logout)
onAuthStateChanged(auth, (user) => {
    if (user) {
        usuarioLogado = user;
        usuarioId = user.uid;
        
        loginBtn.classList.add("d-none");
        logoutBtn.classList.remove("d-none");
        userNameSpan.textContent = `Olá, ${user.displayName}!`;

        // LÓGICA DE PERMISSÃO DE ADMIN
        if (user.email === EMAIL_ADMIN) {
            // Se for o admin, mostra a opção de recorrência
            if(divRecorrencia) divRecorrencia.classList.remove("d-none");
        } else {
            // Se não for admin, garante que está oculto e desmarcado
            if(divRecorrencia) divRecorrencia.classList.add("d-none");
            if(checkRecorrencia) checkRecorrencia.checked = false;
        }

    } else {
        // Usuário deslogado
        usuarioLogado = null;
        usuarioId = null;
        
        loginBtn.classList.remove("d-none");
        logoutBtn.classList.add("d-none");
        userNameSpan.textContent = '';
        
        // Garante que a opção de recorrência suma ao deslogar
        if(divRecorrencia) divRecorrencia.classList.add("d-none");
        if(checkRecorrencia) checkRecorrencia.checked = false;
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
            
            // Permite exclusão se for dono da reserva OU se for o ADMIN
            const isDono = usuarioId && r.extendedProps.usuarioId === usuarioId;
            const isAdmin = auth.currentUser && auth.currentUser.email === EMAIL_ADMIN;

            if (isDono || isAdmin) {
                document.getElementById('modal-reserva-detalhes').textContent = detalhes;
                
                const confirmDeleteModal = new bootstrap.Modal(document.getElementById('confirmDeleteModal'));
                confirmDeleteModal.show();

                const confirmBtn = document.getElementById('confirmDeleteBtn');
                
                // Clone para remover listeners antigos
                const novoConfirmBtn = confirmBtn.cloneNode(true);
                confirmBtn.parentNode.replaceChild(novoConfirmBtn, confirmBtn);

                novoConfirmBtn.onclick = () => {
                    deleteDoc(doc(db, "reservas", r.id))
                        .then(() => {
                            alert("Reserva excluída com sucesso!");
                            confirmDeleteModal.hide();
                        })
                        .catch((error) => {
                            console.error("Erro ao excluir reserva:", error);
                            alert("Falha ao excluir a reserva.");
                        });
                };
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

    // -------------------------------------------------------------
    // SUBMISSÃO DO FORMULÁRIO
    // -------------------------------------------------------------
    reservaForm.addEventListener("submit", async (e) => {
        e.preventDefault();

        if (!usuarioId) {
            alert("Faça login para reservar o auditório.");
            return;
        }

        const dataInicioVal = document.getElementById("dataInicio").value;
        const dataFimVal = document.getElementById("dataFim").value;
        const inicioHora = document.getElementById("inicio").value;
        const fimHora = document.getElementById("fim").value;
        
        // Verifica checkbox, mas aplica filtro de segurança
        let isRecorrente = document.getElementById("repetirSemanal").checked;
        
        // SEGURANÇA EXTRA: Se não for admin, força false na recorrência
        if (auth.currentUser.email !== EMAIL_ADMIN) {
            isRecorrente = false;
        }

        // Criação de datas corrigindo timezone local
        const [anoI, mesI, diaI] = dataInicioVal.split('-').map(Number);
        const [anoF, mesF, diaF] = dataFimVal.split('-').map(Number);
        
        const dataInicioObj = new Date(anoI, mesI - 1, diaI);
        const dataFimObj = new Date(anoF, mesF - 1, diaF);

        if (dataFimObj < dataInicioObj) {
            alert("A Data Limite deve ser igual ou posterior à Data de Início.");
            return;
        }

        const dadosBase = {
            usuarioId: usuarioId,
            nome: document.getElementById("nome").value,
            setor: document.getElementById("setor").value,
            telefone: document.getElementById("telefone").value,
            email: document.getElementById("email").value,
            descricao: document.getElementById("descricao").value,
        };

        // 1. GERAR LISTA DE RESERVAS
        let reservasParaCriar = [];
        let cursorData = new Date(dataInicioObj);
        
        // Se for recorrente (e for admin), vai até dataFim. Se não, executa só uma vez.
        const dataLimiteLoop = isRecorrente ? dataFimObj : dataInicioObj;

        while (cursorData <= dataLimiteLoop) {
            const ano = cursorData.getFullYear();
            const mes = String(cursorData.getMonth() + 1).padStart(2, '0');
            const dia = String(cursorData.getDate()).padStart(2, '0');
            const dataISO = `${ano}-${mes}-${dia}`;

            const inicioEvento = new Date(`${dataISO}T${inicioHora}:00`);
            const fimEvento = new Date(`${dataISO}T${fimHora}:00`);

            if (fimEvento <= inicioEvento) {
                alert("Hora final deve ser maior que a hora inicial.");
                return;
            }

            reservasParaCriar.push({
                ...dadosBase,
                inicio: inicioEvento,
                fim: fimEvento
            });

            if (isRecorrente) {
                cursorData.setDate(cursorData.getDate() + 7);
            } else {
                break; // Encerra o loop após a primeira se não for recorrente
            }
        }

        if (reservasParaCriar.length === 0) {
            alert("Nenhuma data válida gerada.");
            return;
        }

        // 2. VERIFICAÇÃO DE CONFLITOS
        const reservasRef = collection(db, "reservas");
        const snapshot = await getDocs(reservasRef);
        
        let conflitos = [];

        reservasParaCriar.forEach((novaReserva) => {
            snapshot.forEach((docExistente) => {
                const dadosExistente = docExistente.data();
                const existInicio = dadosExistente.inicio.toDate();
                const existFim = dadosExistente.fim.toDate();

                if (novaReserva.inicio < existFim && novaReserva.fim > existInicio) {
                    const diaConflito = novaReserva.inicio.toLocaleDateString('pt-BR');
                    const horaConflito = `${novaReserva.inicio.toLocaleTimeString()} às ${novaReserva.fim.toLocaleTimeString()}`;
                    conflitos.push(`${diaConflito} (${horaConflito})`);
                }
            });
        });

        if (conflitos.length > 0) {
            alert("Não foi possível realizar a reserva. Há conflitos nas seguintes datas:\n\n" + conflitos.join("\n") + "\n\nPor favor, escolha outro horário.");
            return;
        }

        // 3. SALVAR NO FIREBASE
        try {
            const promessas = reservasParaCriar.map(reserva => {
                return addDoc(collection(db, "reservas"), {
                    ...reserva,
                    inicio: Timestamp.fromDate(reserva.inicio),
                    fim: Timestamp.fromDate(reserva.fim)
                });
            });

            await Promise.all(promessas);
            
            alert(`Sucesso! ${reservasParaCriar.length} reserva(s) criada(s).`);
            reservaForm.reset();
            if(checkRecorrencia) checkRecorrencia.checked = false;

        } catch (error) {
            console.error("Erro ao salvar:", error);
            alert("Erro ao criar reservas. Tente novamente.");
        }
    });

    // Função de preenchimento de horários (mantida igual)
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

            if (inicioSel.options.length === 0) {
                horarios.forEach(h => {
                    inicioSel.innerHTML += `<option value="${h}">${h}</option>`;
                    fimSel.innerHTML += `<option value="${h}">${h}</option>`;
                });
            }
        }

        document.getElementById("dataInicio").addEventListener("change", atualizar);
        
        // Popula inicialmente
        if (inicioSel.innerHTML === '') {
             horarios.forEach(h => {
                inicioSel.innerHTML += `<option value="${h}">${h}</option>`;
                fimSel.innerHTML += `<option value="${h}">${h}</option>`;
            });
        }
    }
    preencherHorarios();
});
