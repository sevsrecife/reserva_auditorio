const SESSION_COOKIE = "reserva_session";
const SESSION_TTL_SECONDS = 60 * 60 * 8;
const ADMIN_ROLE = "admin";
const USER_ROLE = "user";
const TIMEZONE = "America/Recife";

const DEFAULT_ALLOWED_ORIGINS = [
  "https://sevsrecife.github.io",
  "http://localhost:8787",
  "http://127.0.0.1:8787",
  "http://localhost:5501",
  "http://127.0.0.1:5501"
];

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS" && url.pathname.startsWith("/api/")) {
      return handleOptions(request, env);
    }

    if (url.pathname.startsWith("/api/")) {
      try {
        return await handleApi(request, env, url);
      } catch (error) {
        console.error("Unhandled API error:", error);
        const origin = request.headers.get("Origin");
        const cors = buildCorsHeaders(origin, env);
        return jsonError("Erro interno no servidor.", 500, cors);
      }
    }

    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    return new Response("Not Found", { status: 404 });
  }
};

async function handleApi(request, env, url) {
  const method = request.method.toUpperCase();
  const origin = request.headers.get("Origin");
  const session = await getSessionFromRequest(request, env);
  const cors = buildCorsHeaders(origin, env);

  if (url.pathname === "/api/config" && method === "GET") {
    return jsonResponse({
      googleClientId: env.GOOGLE_CLIENT_ID || "",
      appName: "Reserva de Auditório"
    }, 200, cors);
  }

  if (url.pathname === "/api/session" && method === "GET") {
    if (!session) {
      return jsonResponse({ authenticated: false }, 200, cors);
    }

    return jsonResponse({
      authenticated: true,
      role: session.role,
      user: {
        id: session.sub,
        name: session.name,
        email: session.email
      }
    }, 200, cors);
  }

  if (url.pathname === "/api/auth/google" && method === "POST") {
    if (!env.GOOGLE_CLIENT_ID) {
      return jsonError("Configuração OAuth do Google ausente no servidor.", 500, cors);
    }

    const body = await parseJsonBody(request);
    if (!body?.idToken) {
      return jsonError("Token do Google ausente.", 400, cors);
    }

    const googleUser = await validateGoogleIdToken(body.idToken, env.GOOGLE_CLIENT_ID);
    if (!googleUser) {
      return jsonError("Falha na autenticação com Google.", 401, cors);
    }

    const payload = {
      sub: googleUser.sub,
      email: googleUser.email,
      name: googleUser.name || googleUser.email,
      role: USER_ROLE
    };

    return jsonResponse(
      { message: "Login realizado com sucesso." },
      200,
      withSetCookie(cors, await buildSessionCookie(payload, env.SESSION_SECRET, request))
    );
  }

  if (url.pathname === "/api/admin/login" && method === "POST") {
    if (!env.ADMIN_USERNAME || !env.ADMIN_PASSWORD_HASH || !env.ADMIN_PASSWORD_SALT) {
      return jsonError("Configuração administrativa ausente no servidor.", 500, cors);
    }

    const blocked = await checkAdminRateLimit(request, env);
    if (blocked) {
      return jsonError("Muitas tentativas. Tente novamente mais tarde.", 429, cors);
    }

    const body = await parseJsonBody(request);
    const username = normalizeText(body?.username);
    const password = normalizeText(body?.password);
    if (!username || !password) {
      await registerAdminLoginFailure(request, env);
      return jsonError("Usuário e senha são obrigatórios.", 400, cors);
    }

    if (username !== env.ADMIN_USERNAME) {
      await registerAdminLoginFailure(request, env);
      return jsonError("Credenciais administrativas inválidas.", 401, cors);
    }

    const hashedPassword = await sha256Hex(`${password}${env.ADMIN_PASSWORD_SALT}`);
    if (hashedPassword !== env.ADMIN_PASSWORD_HASH) {
      await registerAdminLoginFailure(request, env);
      return jsonError("Credenciais administrativas inválidas.", 401, cors);
    }

    await clearAdminRateLimit(request, env);

    const payload = {
      sub: "admin",
      email: env.ADMIN_USERNAME,
      name: "Administrador",
      role: ADMIN_ROLE
    };

    return jsonResponse(
      { message: "Login administrativo realizado com sucesso." },
      200,
      withSetCookie(cors, await buildSessionCookie(payload, env.SESSION_SECRET, request))
    );
  }

  if (url.pathname === "/api/auth/logout" && method === "POST") {
    return jsonResponse(
      { message: "Logout realizado." },
      200,
      withSetCookie(cors, clearSessionCookie(request))
    );
  }

  if (url.pathname === "/api/reservas" && method === "GET") {
    const rows = await env.RESERVAS_DB.prepare(
      `SELECT *
       FROM reservations
       WHERE status != 'cancelada'
       ORDER BY inicio_iso ASC`
    ).all();

    const reservations = (rows.results || []).map((row) => {
      if (!session) {
        return serializePublicReservation(row);
      }
      return serializeReservation(row, session, session.role === ADMIN_ROLE);
    });
    return jsonResponse({ reservas: reservations }, 200, cors);
  }

  if (url.pathname === "/api/minhas-reservas" && method === "GET") {
    if (!session || session.role !== USER_ROLE) {
      return jsonError("Usuário não autenticado.", 401, cors);
    }

    const rows = await env.RESERVAS_DB.prepare(
      `SELECT *
       FROM reservations
       WHERE owner_google_id = ?
         AND status != 'cancelada'
       ORDER BY inicio_iso ASC`
    ).bind(session.sub).all();

    const reservations = (rows.results || []).map((row) => serializeReservation(row, session, false));
    return jsonResponse({ reservas: reservations }, 200, cors);
  }

  if (url.pathname === "/api/reservas" && method === "POST") {
    if (!session) {
      return jsonError("Usuário não autenticado.", 401, cors);
    }
    if (session.role !== USER_ROLE) {
      return jsonError("Administrador não pode criar reservas.", 403, cors);
    }

    const body = await parseJsonBody(request);
    const normalized = normalizeReservationBody(body);
    if (!normalized.valid) {
      return jsonError(normalized.message, 400, cors);
    }

    if (normalized.recurrencePattern !== "single") {
      return jsonError("Usuários autenticados só podem criar reservas únicas. Reservas recorrentes são exclusivas do administrador.", 403, cors);
    }

    let occurrenceDates;
    try {
      occurrenceDates = generateOccurrenceDates(normalized);
    } catch (error) {
      return jsonError(error.message || "Recorrência inválida.", 400, cors);
    }
    if (!occurrenceDates.length) {
      return jsonError("A recorrência informada não gera nenhuma ocorrência válida.", 400, cors);
    }
    const conflicts = await findConflictsForOccurrences(env, occurrenceDates, normalized, null);
    if (conflicts.length) {
      return jsonResponse({
        error: "Existem conflitos de horário.",
        conflicts: conflicts.map(formatConflict)
      }, 409, cors);
    }

    const nowIso = new Date().toISOString();
    const seriesId = normalized.recurrencePattern === "single" ? null : crypto.randomUUID();
    const reservations = [];

    for (let index = 0; index < occurrenceDates.length; index += 1) {
      const occurrenceDate = occurrenceDates[index];
      const reservation = await insertReservation(env, {
        id: crypto.randomUUID(),
        ownerGoogleId: session.sub,
        ownerName: session.name,
        ownerEmail: session.email,
        nome: normalized.nome,
        setor: normalized.setor,
        telefone: normalized.telefone,
        emailContato: normalized.emailContato,
        descricao: normalized.descricao,
        dataReserva: occurrenceDate,
        horaInicio: normalized.horaInicio,
        horaFim: normalized.horaFim,
        inicioIso: buildLocalIso(occurrenceDate, normalized.horaInicio),
        fimIso: buildLocalIso(occurrenceDate, normalized.horaFim),
        status: "ativa",
        googleCalendarUrl: buildGoogleCalendarUrl({
          title: normalized.descricao,
          startIso: buildLocalIso(occurrenceDate, normalized.horaInicio),
          endIso: buildLocalIso(occurrenceDate, normalized.horaFim),
          description: buildReservationDescription({
            descricao: normalized.descricao,
            ownerName: session.name,
            ownerEmail: session.email,
            setor: normalized.setor,
            telefone: normalized.telefone
          }),
          location: "Auditório",
          attendees: []
        }),
        createdAt: nowIso,
        updatedAt: nowIso,
        isImported: 0,
        sourceOrigin: "manual",
        sourceReference: null,
        auditPayloadJson: JSON.stringify({
          requestedBy: {
            id: session.sub,
            name: session.name,
            email: session.email
          },
          original: body || null
        }),
        recurrencePattern: normalized.recurrencePattern,
        recurrenceSeriesId: seriesId,
        recurrenceOccurrence: index,
        recurrenceUntil: normalized.recurrenceUntil || null,
        recurrenceWeekdaysJson: JSON.stringify(normalized.recurrenceWeekdays || []),
        createdByRole: session.role,
        updatedByRole: session.role
      });
      reservations.push(reservation);
    }

    return jsonResponse({
      message: reservations.length > 1
        ? "Série de reservas criada com sucesso."
        : "Reserva criada com sucesso.",
      reservation: reservations[0],
      reservations,
      seriesId,
      googleCalendarUrl: reservations[0]?.googleCalendarUrl || null
    }, 201, cors);
  }

  if (url.pathname.startsWith("/api/reservas/") && method === "DELETE") {
    const reservationId = url.pathname.split("/").pop();
    const scope = normalizeDeleteScope(url.searchParams.get("scope"));
    return handleReservationDelete(env, session, reservationId, scope, cors, false);
  }

  if (url.pathname === "/api/admin/reservas" && method === "GET") {
    if (!session || session.role !== ADMIN_ROLE) {
      return jsonError("Acesso administrativo não autorizado.", 403, cors);
    }

    const rows = await env.RESERVAS_DB.prepare(
      `SELECT *
       FROM reservations
       ORDER BY inicio_iso ASC`
    ).all();

    const reservations = (rows.results || []).map((row) => serializeReservation(row, session, true));
    return jsonResponse({ reservas: reservations }, 200, cors);
  }

  if (url.pathname.startsWith("/api/admin/reservas/") && method === "PUT") {
    if (!session || session.role !== ADMIN_ROLE) {
      return jsonError("Acesso administrativo não autorizado.", 403, cors);
    }

    const reservationId = url.pathname.split("/").pop();
    if (!reservationId) {
      return jsonError("ID da reserva inválido.", 400, cors);
    }

    const existing = await env.RESERVAS_DB.prepare(
      `SELECT *
       FROM reservations
       WHERE id = ?`
    ).bind(reservationId).first();
    if (!existing) {
      return jsonError("Reserva não encontrada.", 404, cors);
    }

    const body = await parseJsonBody(request);
    const normalized = normalizeReservationBody(body, { requireRecurringEnd: false });
    if (!normalized.valid) {
      return jsonError(normalized.message, 400, cors);
    }

    const conflictInput = {
      ...normalized,
      recurrencePattern: "single",
      recurrenceWeekdays: []
    };
    const candidateDate = normalized.dataReserva;
    const conflicts = await findConflictsForOccurrences(env, [candidateDate], conflictInput, reservationId);
    if (conflicts.length) {
      return jsonResponse({
        error: "Existem conflitos de horário.",
        conflicts: conflicts.map(formatConflict)
      }, 409, cors);
    }

    const updatedAt = new Date().toISOString();
    await env.RESERVAS_DB.prepare(
      `UPDATE reservations
       SET nome = ?, setor = ?, telefone = ?, email_contato = ?, descricao = ?,
           data_reserva = ?, hora_inicio = ?, hora_fim = ?, inicio_iso = ?, fim_iso = ?,
           status = ?, updated_at = ?, updated_by_role = ?
       WHERE id = ?`
    ).bind(
      normalized.nome,
      normalized.setor,
      normalized.telefone,
      normalized.emailContato,
      normalized.descricao,
      normalized.dataReserva,
      normalized.horaInicio,
      normalized.horaFim,
      buildLocalIso(normalized.dataReserva, normalized.horaInicio),
      buildLocalIso(normalized.dataReserva, normalized.horaFim),
      normalized.status,
      updatedAt,
      session.role,
      reservationId
    ).run();

    return jsonResponse({ message: "Reserva atualizada com sucesso." }, 200, cors);
  }

  if (url.pathname === "/api/admin/reservas" && method === "POST") {
    return jsonError("Administrador não pode criar reservas.", 403, cors);
  }

  if (url.pathname.startsWith("/api/admin/reservas/") && method === "DELETE") {
    const reservationId = url.pathname.split("/").pop();
    const scope = normalizeDeleteScope(url.searchParams.get("scope"));
    return handleReservationDelete(env, session, reservationId, scope, cors, true);
  }

  return jsonError("Rota não encontrada.", 404, cors);
}

async function handleOptions(request, env) {
  const origin = request.headers.get("Origin");
  const cors = buildCorsHeaders(origin, env, request.headers.get("Access-Control-Request-Headers") || "");
  return new Response(null, {
    status: 204,
    headers: cors
  });
}

function buildCorsHeaders(origin, env, requestedHeaders = "Content-Type, Authorization") {
  const headers = new Headers();
  if (isAllowedOrigin(origin, env)) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Access-Control-Allow-Credentials", "true");
    headers.set("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
    headers.set("Access-Control-Allow-Headers", requestedHeaders || "Content-Type, Authorization");
    headers.set("Access-Control-Max-Age", "86400");
    headers.append("Vary", "Origin");
  }
  return headers;
}

function withSetCookie(baseHeaders, setCookieValue) {
  const headers = new Headers(baseHeaders);
  headers.set("Set-Cookie", setCookieValue);
  return headers;
}

function isAllowedOrigin(origin, env) {
  if (!origin) {
    return false;
  }

  const configured = String(env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const allowed = configured.length ? configured : DEFAULT_ALLOWED_ORIGINS;
  return allowed.includes(origin);
}

async function handleReservationDelete(env, session, reservationId, scope, cors, adminOnly = false) {
  if (adminOnly) {
    if (!session || session.role !== ADMIN_ROLE) {
      return jsonError("Acesso administrativo não autorizado.", 403, cors);
    }
  } else if (!session) {
    return jsonError("Usuário não autenticado.", 401, cors);
  }

  if (!reservationId) {
    return jsonError("ID da reserva inválido.", 400, cors);
  }

  const existing = await env.RESERVAS_DB.prepare(
    `SELECT id, owner_google_id, is_imported, recurrence_pattern, recurrence_series_id
     FROM reservations
     WHERE id = ?`
  ).bind(reservationId).first();

  if (!existing) {
    return jsonError("Reserva não encontrada.", 404, cors);
  }

  const canDelete =
    session.role === ADMIN_ROLE ||
    (session.role === USER_ROLE && !existing.is_imported && existing.owner_google_id === session.sub);

  if (!canDelete) {
    return jsonError(
      existing.is_imported
        ? "Reservas importadas só podem ser alteradas ou excluídas por um administrador."
        : "Acesso não autorizado para excluir esta reserva.",
      403,
      cors
    );
  }

  if (scope === "series") {
    if (existing.recurrence_pattern === "single" || !existing.recurrence_series_id) {
      return jsonError("Esta reserva não possui uma série recorrente para excluir.", 400, cors);
    }

    await env.RESERVAS_DB.prepare("DELETE FROM reservations WHERE recurrence_series_id = ?")
      .bind(existing.recurrence_series_id)
      .run();

    return jsonResponse({ message: "Série de reservas excluída com sucesso." }, 200, cors);
  }

  await env.RESERVAS_DB.prepare("DELETE FROM reservations WHERE id = ?")
    .bind(reservationId)
    .run();

  return jsonResponse({ message: "Reserva excluída com sucesso." }, 200, cors);
}

function normalizeDeleteScope(value) {
  return String(value || "").toLowerCase() === "series" ? "series" : "single";
}

async function insertReservation(env, record) {
  await env.RESERVAS_DB.prepare(
    `INSERT INTO reservations (
      id, owner_google_id, owner_name, owner_email,
      nome, setor, telefone, email_contato, descricao,
      data_reserva, hora_inicio, hora_fim, inicio_iso, fim_iso,
      status, google_calendar_url, created_at, updated_at,
      is_imported, source_origin, source_reference, audit_payload_json,
      recurrence_pattern, recurrence_series_id, recurrence_occurrence,
      recurrence_until, recurrence_weekdays_json, created_by_role, updated_by_role
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    record.id,
    record.ownerGoogleId,
    record.ownerName,
    record.ownerEmail,
    record.nome,
    record.setor,
    record.telefone,
    record.emailContato,
    record.descricao,
    record.dataReserva,
    record.horaInicio,
    record.horaFim,
    record.inicioIso,
    record.fimIso,
    record.status,
    record.googleCalendarUrl,
    record.createdAt,
    record.updatedAt,
    record.isImported,
    record.sourceOrigin,
    record.sourceReference,
    record.auditPayloadJson,
    record.recurrencePattern,
    record.recurrenceSeriesId,
    record.recurrenceOccurrence,
    record.recurrenceUntil,
    record.recurrenceWeekdaysJson,
    record.createdByRole,
    record.updatedByRole
  ).run();

  return {
    id: record.id,
    ownerGoogleId: record.ownerGoogleId,
    ownerName: record.ownerName,
    ownerEmail: record.ownerEmail,
    nome: record.nome,
    setor: record.setor,
    telefone: record.telefone,
    emailContato: record.emailContato,
    descricao: record.descricao,
    dataReserva: record.dataReserva,
    horaInicio: record.horaInicio,
    horaFim: record.horaFim,
    inicioIso: record.inicioIso,
    fimIso: record.fimIso,
    status: record.status,
    googleCalendarUrl: record.googleCalendarUrl,
    isImported: Boolean(record.isImported),
    sourceOrigin: record.sourceOrigin,
    sourceReference: record.sourceReference,
    recurrencePattern: record.recurrencePattern,
    recurrenceSeriesId: record.recurrenceSeriesId,
    recurrenceOccurrence: record.recurrenceOccurrence,
    recurrenceUntil: record.recurrenceUntil,
    recurrenceWeekdays: JSON.parse(record.recurrenceWeekdaysJson || "[]")
  };
}

function serializeReservation(row, session, isAdmin) {
  const isOwner = session?.sub && row.owner_google_id === session.sub;
  const canDelete = isAdmin || (isOwner && !row.is_imported);
  const canEdit = isAdmin;
  const business = reservationBusinessView(row);

  const base = {
    id: row.id,
    nome: row.nome,
    setor: row.setor,
    telefone: row.telefone,
    emailContato: row.email_contato,
    descricao: row.descricao,
    dataReserva: business.dataReserva,
    horaInicio: business.horaInicio,
    horaFim: business.horaFim,
    inicioIso: row.inicio_iso,
    fimIso: row.fim_iso,
    status: row.status,
    isImported: Boolean(row.is_imported),
    sourceOrigin: row.source_origin,
    sourceReference: row.source_reference,
    recurrencePattern: row.recurrence_pattern,
    recurrenceSeriesId: row.recurrence_series_id,
    recurrenceOccurrence: row.recurrence_occurrence,
    recurrenceUntil: row.recurrence_until,
    recurrenceWeekdays: safeJsonParse(row.recurrence_weekdays_json, []),
    canDelete,
    canEdit,
    ownerName: row.owner_name
  };

  if (isAdmin) {
    base.ownerGoogleId = row.owner_google_id;
    base.ownerEmail = row.owner_email;
    base.createdAt = row.created_at;
    base.updatedAt = row.updated_at;
    base.createdByRole = row.created_by_role;
    base.updatedByRole = row.updated_by_role;
    base.auditPayloadJson = row.audit_payload_json;
    base.googleCalendarUrl = row.google_calendar_url;
  }

  return base;
}

function serializePublicReservation(row) {
  const business = reservationBusinessView(row);
  return {
    id: row.id,
    descricao: row.descricao,
    dataReserva: business.dataReserva,
    horaInicio: business.horaInicio,
    horaFim: business.horaFim,
    inicioIso: row.inicio_iso,
    fimIso: row.fim_iso,
    status: row.status,
    isImported: Boolean(row.is_imported),
    sourceOrigin: row.source_origin,
    recurrencePattern: row.recurrence_pattern,
    recurrenceSeriesId: row.recurrence_series_id,
    recurrenceOccurrence: row.recurrence_occurrence,
    recurrenceUntil: row.recurrence_until,
    recurrenceWeekdays: safeJsonParse(row.recurrence_weekdays_json, []),
    ownerName: row.owner_name,
    canDelete: false,
    canEdit: false
  };
}

function normalizeReservationBody(body, options = {}) {
  const nome = normalizeText(body?.nome || body?.responsavel || "");
  const setor = normalizeText(body?.setor || "");
  const telefone = normalizeText(body?.telefone || "");
  const emailContato = normalizeText(body?.emailContato || body?.email || "");
  const descricao = normalizeText(body?.descricao || "");
  const dataReserva = normalizeText(body?.dataReserva || body?.dataInicio || body?.date || "");
  const dataFim = normalizeText(body?.dataFim || body?.recurrenceUntil || dataReserva);
  const horaInicio = normalizeText(body?.horaInicio || body?.inicio || "");
  const horaFim = normalizeText(body?.horaFim || body?.fim || "");
  const status = normalizeText(body?.status || "ativa") || "ativa";
  const recurrencePattern = normalizeRecurrencePattern(body?.recurrencePattern || body?.recurrence?.pattern || "single");
  const recurrenceWeekdays = parseWeekdays(body?.recurrenceWeekdays || body?.recurrence?.weekdays || []);

  if (!nome || !setor || !telefone || !emailContato || !descricao || !dataReserva || !horaInicio || !horaFim) {
    return { valid: false, message: "Dados obrigatórios ausentes para a reserva." };
  }

  if (!isValidEmail(emailContato)) {
    return { valid: false, message: "E-mail da reserva inválido." };
  }

  if (!isValidDate(dataReserva) || !isValidDate(dataFim)) {
    return { valid: false, message: "Data da reserva inválida." };
  }

  if (!isValidTime(horaInicio) || !isValidTime(horaFim)) {
    return { valid: false, message: "Horário inválido." };
  }

  if (!isWorkingTime(horaInicio) || !isWorkingTime(horaFim)) {
    return { valid: false, message: "Horários permitidos: 08:00 até 17:00, de 30 em 30 minutos." };
  }

  if (!["ativa", "cancelada"].includes(status)) {
    return { valid: false, message: "Status de reserva inválido." };
  }

  if (!isWorkingDate(dataReserva)) {
    return { valid: false, message: "Só é permitido reservar de segunda a sexta-feira." };
  }

  if (compareDateStrings(dataFim, dataReserva) < 0) {
    return { valid: false, message: "A data final precisa ser igual ou posterior à data inicial." };
  }

  if (compareTimes(horaFim, horaInicio) <= 0) {
    return { valid: false, message: "Hora final deve ser maior que a hora inicial." };
  }

  if (recurrencePattern !== "single" && !options.allowRecurringEnd && compareDateStrings(dataFim, dataReserva) < 0) {
    return { valid: false, message: "A recorrência precisa ter data final válida." };
  }

  const normalizedWeekdays = recurrencePattern === "weekly"
    ? (recurrenceWeekdays.length ? recurrenceWeekdays : [weekdayFromDate(dataReserva)])
    : [];

  return {
    valid: true,
    nome,
    setor,
    telefone,
    emailContato,
    descricao,
    dataReserva,
    dataFim,
    horaInicio,
    horaFim,
    status,
    recurrencePattern,
    recurrenceWeekdays: normalizedWeekdays,
    recurrenceUntil: recurrencePattern === "single" ? null : dataFim
  };
}

function generateOccurrenceDates(normalized) {
  if (normalized.recurrencePattern === "single") {
    return [normalized.dataReserva];
  }

  if (normalized.recurrencePattern === "daily") {
    return enumerateDates(normalized.dataReserva, normalized.dataFim);
  }

  if (normalized.recurrencePattern === "weekly") {
    const dates = [];
    for (const date of enumerateDates(normalized.dataReserva, normalized.dataFim)) {
      if (normalized.recurrenceWeekdays.includes(weekdayFromDate(date))) {
        dates.push(date);
      }
    }
    if (!dates.length) {
      return [];
    }
    return dates;
  }

  if (normalized.recurrencePattern === "monthly") {
    return enumerateMonthlyDates(normalized.dataReserva, normalized.dataFim);
  }

  return [normalized.dataReserva];
}

async function findConflictsForOccurrences(env, occurrenceDates, normalized, excludeReservationId) {
  const conflicts = [];
  const seenIntervals = [];
  for (const occurrenceDate of occurrenceDates) {
    const startIso = buildLocalIso(occurrenceDate, normalized.horaInicio);
    const endIso = buildLocalIso(occurrenceDate, normalized.horaFim);

    for (const seen of seenIntervals) {
      if (intervalsOverlap(startIso, endIso, seen.startIso, seen.endIso)) {
        conflicts.push({
          id: seen.id,
          inicioIso: seen.startIso,
          fimIso: seen.endIso,
          descricao: seen.descricao,
          dataReserva: seen.dataReserva
        });
      }
    }

    const query = excludeReservationId
      ? `SELECT id, inicio_iso, fim_iso, descricao, data_reserva
         FROM reservations
         WHERE id != ?
           AND status != 'cancelada'
           AND inicio_iso < ?
           AND fim_iso > ?
         LIMIT 20`
      : `SELECT id, inicio_iso, fim_iso, descricao, data_reserva
         FROM reservations
         WHERE status != 'cancelada'
           AND inicio_iso < ?
           AND fim_iso > ?
         LIMIT 20`;

    const stmt = excludeReservationId
      ? env.RESERVAS_DB.prepare(query).bind(excludeReservationId, endIso, startIso)
      : env.RESERVAS_DB.prepare(query).bind(endIso, startIso);
    const rows = await stmt.all();
    for (const row of rows.results || []) {
      conflicts.push({
        id: row.id,
        inicioIso: row.inicio_iso,
        fimIso: row.fim_iso,
        descricao: row.descricao,
        dataReserva: formatDateInTimezone(row.inicio_iso)
      });
    }

    seenIntervals.push({
      id: "__pending__",
      startIso,
      endIso,
      descricao: normalized.descricao,
      dataReserva: occurrenceDate
    });
  }

  const unique = new Map();
  for (const conflict of conflicts) {
    unique.set(`${conflict.id}|${conflict.inicioIso}|${conflict.fimIso}`, conflict);
  }
  return [...unique.values()];
}

function formatConflict(conflict) {
  return {
    id: conflict.id,
    descricao: conflict.descricao,
    dataReserva: formatDateInTimezone(conflict.inicioIso),
    inicio: formatDateTime(conflict.inicioIso),
    fim: formatDateTime(conflict.fimIso)
  };
}

function reservationBusinessView(row) {
  return {
    dataReserva: formatDateInTimezone(row.inicio_iso),
    horaInicio: formatTimeInTimezone(row.inicio_iso),
    horaFim: formatTimeInTimezone(row.fim_iso)
  };
}

function buildReservationDescription({ descricao, ownerName, ownerEmail, setor, telefone }) {
  const lines = [
    descricao,
    `Responsável: ${ownerName} (${ownerEmail})`,
    `Setor: ${setor}`,
    `Telefone: ${telefone}`
  ];
  return lines.join("\n");
}

function buildGoogleCalendarUrl({ title, startIso, endIso, description, location, attendees = [] }) {
  const params = new URLSearchParams({
    action: "TEMPLATE",
    text: title,
    dates: `${formatGoogleDate(startIso)}/${formatGoogleDate(endIso)}`,
    details: description || "",
    location: location || ""
  });

  if (attendees.length) {
    params.set("add", attendees.join(","));
  }

  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

function compareDateStrings(a, b) {
  return a.localeCompare(b);
}

function compareTimes(a, b) {
  return a.localeCompare(b);
}

function enumerateDates(startDate, endDate) {
  const dates = [];
  let cursor = startDate;
  while (compareDateStrings(cursor, endDate) <= 0) {
    dates.push(cursor);
    cursor = addDays(cursor, 1);
  }
  return dates;
}

function enumerateMonthlyDates(startDate, endDate) {
  const dates = [];
  const [year, month, day] = startDate.split("-").map(Number);
  const targetDay = day;
  let current = new Date(Date.UTC(year, month - 1, day));
  const limit = new Date(`${endDate}T00:00:00-03:00`);
  while (current <= limit) {
    const currentYear = current.getUTCFullYear();
    const currentMonth = current.getUTCMonth() + 1;
    const currentDay = current.getUTCDate();
    if (currentDay !== targetDay) {
      throw new Error("A recorrência mensal não pode gerar datas inexistentes.");
    }
    const dateString = `${String(currentYear).padStart(4, "0")}-${String(currentMonth).padStart(2, "0")}-${String(currentDay).padStart(2, "0")}`;
    dates.push(dateString);
    current = new Date(Date.UTC(currentYear, currentMonth, targetDay));
  }
  return dates;
}

function addDays(dateString, amount) {
  const base = new Date(`${dateString}T00:00:00-03:00`);
  base.setUTCDate(base.getUTCDate() + amount);
  return base.toISOString().slice(0, 10);
}

function weekdayFromDate(dateString) {
  return new Date(`${dateString}T00:00:00-03:00`).getUTCDay();
}

function isWorkingDate(dateString) {
  const weekday = weekdayFromDate(dateString);
  return weekday >= 1 && weekday <= 5;
}

function isValidDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function isValidTime(value) {
  return /^(0[8-9]|1[0-6]|17):(00|30)$/.test(value);
}

function isWorkingTime(value) {
  if (!isValidTime(value)) {
    return false;
  }
  return value !== "17:30";
}

function buildLocalIso(date, time) {
  return new Date(`${date}T${time}:00-03:00`).toISOString();
}

function intervalsOverlap(startA, endA, startB, endB) {
  return startA < endB && endA > startB;
}

function formatDate(value) {
  if (!value) {
    return "";
  }
  const [year, month, day] = value.split("-");
  return `${day}/${month}/${year}`;
}

function formatDateTime(iso) {
  return new Intl.DateTimeFormat("pt-BR", {
    timeZone: TIMEZONE,
    dateStyle: "short",
    timeStyle: "short"
  }).format(new Date(iso));
}

function formatDateInTimezone(iso) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date(iso));
  const year = parts.find((part) => part.type === "year")?.value || "";
  const month = parts.find((part) => part.type === "month")?.value || "";
  const day = parts.find((part) => part.type === "day")?.value || "";
  return `${year}-${month}-${day}`;
}

function formatTimeInTimezone(iso) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: TIMEZONE,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(new Date(iso));
}

function formatGoogleDate(isoDate) {
  return new Date(isoDate).toISOString().replace(/[-:]/g, "").replace(".000", "");
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeRecurrencePattern(value) {
  const normalized = normalizeText(value).toLowerCase();
  if (["single", "daily", "weekly", "monthly"].includes(normalized)) {
    return normalized;
  }
  return "single";
}

function parseWeekdays(value) {
  const items = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(",")
      : [];
  return [...new Set(items.map((item) => Number(item)).filter((item) => Number.isInteger(item) && item >= 0 && item <= 6))].sort((a, b) => a - b);
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function safeJsonParse(value, fallback) {
  if (!value) {
    return fallback;
  }
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

async function parseJsonBody(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function jsonResponse(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...Object.fromEntries(headers.entries ? headers.entries() : Object.entries(headers))
    }
  });
}

function jsonError(message, status = 400, headers = {}) {
  return jsonResponse({ error: message }, status, headers);
}

async function buildSessionCookie(payload, sessionSecret, request) {
  const exp = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
  const completePayload = { ...payload, exp };
  const encodedPayload = toBase64Url(JSON.stringify(completePayload));
  const signature = await hmacSign(encodedPayload, sessionSecret);
  return `${SESSION_COOKIE}=${encodedPayload}.${signature}; Path=/; HttpOnly; ${cookieSecureFlag(request)} SameSite=${cookieSameSite(request)}; Max-Age=${SESSION_TTL_SECONDS}`;
}

function clearSessionCookie(request) {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; ${cookieSecureFlag(request)} SameSite=${cookieSameSite(request)}; Max-Age=0`;
}

function cookieSecureFlag(request) {
  return request.url.startsWith("https:") ? "Secure; " : "";
}

function cookieSameSite(request) {
  return request.url.startsWith("https:") ? "None" : "Lax";
}

async function getSessionFromRequest(request, env) {
  const cookies = parseCookies(request.headers.get("Cookie") || "");
  const raw = cookies[SESSION_COOKIE];
  if (!raw) {
    return null;
  }

  const [payloadEncoded, signature] = raw.split(".");
  if (!payloadEncoded || !signature) {
    return null;
  }

  const expectedSignature = await hmacSign(payloadEncoded, env.SESSION_SECRET);
  if (!timingSafeEqual(signature, expectedSignature)) {
    return null;
  }

  const payloadJson = fromBase64Url(payloadEncoded);
  if (!payloadJson) {
    return null;
  }

  let payload;
  try {
    payload = JSON.parse(payloadJson);
  } catch {
    return null;
  }

  if (!payload?.exp || payload.exp < Math.floor(Date.now() / 1000)) {
    return null;
  }

  return payload;
}

function parseCookies(cookieHeader) {
  return cookieHeader
    .split(";")
    .map((value) => value.trim())
    .filter(Boolean)
    .reduce((acc, item) => {
      const index = item.indexOf("=");
      if (index <= 0) {
        return acc;
      }
      acc[item.slice(0, index)] = item.slice(index + 1);
      return acc;
    }, {});
}

function toBase64Url(input) {
  const bytes = new TextEncoder().encode(input);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function fromBase64Url(input) {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  const padLength = (4 - (normalized.length % 4)) % 4;
  const padded = normalized + "=".repeat(padLength);
  try {
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

async function hmacSign(value, secret) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(value)
  );
  return toHex(signature);
}

function toHex(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  return Array.from(bytes).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) {
    return false;
  }
  let result = 0;
  for (let i = 0; i < a.length; i += 1) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

async function validateGoogleIdToken(idToken, expectedClientId) {
  let response;
  try {
    response = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`);
  } catch {
    return null;
  }
  if (!response.ok) {
    return null;
  }

  const data = await response.json();
  const issuerValid = data.iss === "accounts.google.com" || data.iss === "https://accounts.google.com";
  if (data.aud !== expectedClientId || data.email_verified !== "true" || !issuerValid) {
    return null;
  }

  return {
    sub: data.sub,
    email: data.email,
    name: data.name || data.given_name || data.email
  };
}

async function sha256Hex(value) {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return toHex(hash);
}

async function checkAdminRateLimit(request, env) {
  if (!env.ADMIN_LOGIN_KV) {
    return false;
  }

  const key = `admin-login:${getClientIp(request)}`;
  const recordRaw = await env.ADMIN_LOGIN_KV.get(key);
  if (!recordRaw) {
    return false;
  }

  const record = JSON.parse(recordRaw);
  return Boolean(record.blockedUntil && record.blockedUntil > Date.now());
}

async function registerAdminLoginFailure(request, env) {
  if (!env.ADMIN_LOGIN_KV) {
    return;
  }

  const key = `admin-login:${getClientIp(request)}`;
  const recordRaw = await env.ADMIN_LOGIN_KV.get(key);
  const record = recordRaw ? JSON.parse(recordRaw) : { count: 0, blockedUntil: 0 };
  record.count += 1;
  if (record.count >= 5) {
    record.blockedUntil = Date.now() + 15 * 60 * 1000;
    record.count = 0;
  }
  await env.ADMIN_LOGIN_KV.put(key, JSON.stringify(record), { expirationTtl: 15 * 60 });
}

async function clearAdminRateLimit(request, env) {
  if (!env.ADMIN_LOGIN_KV) {
    return;
  }
  await env.ADMIN_LOGIN_KV.delete(`admin-login:${getClientIp(request)}`);
}

function getClientIp(request) {
  return request.headers.get("CF-Connecting-IP") || "unknown";
}
