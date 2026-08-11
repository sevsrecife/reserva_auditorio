const SESSION_COOKIE = "reserva_session";
const SESSION_TTL_SECONDS = 60 * 60 * 8;
const ADMIN_ROLE = "admin";
const USER_ROLE = "user";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      return handleApi(request, env, url);
    }

    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    return new Response("Not Found", { status: 404 });
  }
};

async function handleApi(request, env, url) {
  const method = request.method.toUpperCase();
  const hasSessionSecret = Boolean(env.SESSION_SECRET);
  if (!hasSessionSecret && url.pathname !== "/api/config") {
    return jsonError("Configuração de sessão ausente no servidor.", 500);
  }
  const session = await getSessionFromRequest(request, env);

  if (url.pathname === "/api/config" && method === "GET") {
    return jsonResponse({
      googleClientId: env.GOOGLE_CLIENT_ID || ""
    });
  }

  if (url.pathname === "/api/session" && method === "GET") {
    if (!session) {
      return jsonResponse({ authenticated: false });
    }
    return jsonResponse({
      authenticated: true,
      role: session.role,
      user: {
        id: session.sub,
        name: session.name,
        email: session.email
      }
    });
  }

  if (url.pathname === "/api/auth/google" && method === "POST") {
    if (!env.GOOGLE_CLIENT_ID) {
      return jsonError("Configuração OAuth do Google ausente no servidor.", 500);
    }
    const body = await parseJsonBody(request);
    if (!body?.idToken) {
      return jsonError("Token do Google ausente.", 400);
    }

    const googleUser = await validateGoogleIdToken(body.idToken, env.GOOGLE_CLIENT_ID);
    if (!googleUser) {
      return jsonError("Falha na autenticação com Google.", 401);
    }

    const payload = {
      sub: googleUser.sub,
      email: googleUser.email,
      name: googleUser.name || googleUser.email,
      role: USER_ROLE
    };
    const sessionCookie = await buildSessionCookie(payload, env.SESSION_SECRET);

    return jsonResponse(
      { message: "Login realizado com sucesso." },
      200,
      { "Set-Cookie": sessionCookie }
    );
  }

  if (url.pathname === "/api/admin/login" && method === "POST") {
    if (!env.ADMIN_USERNAME || !env.ADMIN_PASSWORD_HASH || !env.ADMIN_PASSWORD_SALT) {
      return jsonError("Configuração administrativa ausente no servidor.", 500);
    }
    const blocked = await checkAdminRateLimit(request, env);
    if (blocked) {
      return jsonError("Muitas tentativas. Tente novamente mais tarde.", 429);
    }

    const body = await parseJsonBody(request);
    const username = normalizeText(body?.username);
    const password = normalizeText(body?.password);
    if (!username || !password) {
      await registerAdminLoginFailure(request, env);
      return jsonError("Usuário e senha são obrigatórios.", 400);
    }

    if (username !== env.ADMIN_USERNAME) {
      await registerAdminLoginFailure(request, env);
      return jsonError("Credenciais administrativas inválidas.", 401);
    }

    const hashedPassword = await sha256Hex(`${password}${env.ADMIN_PASSWORD_SALT}`);
    if (hashedPassword !== env.ADMIN_PASSWORD_HASH) {
      await registerAdminLoginFailure(request, env);
      return jsonError("Credenciais administrativas inválidas.", 401);
    }

    await clearAdminRateLimit(request, env);
    const payload = {
      sub: "admin",
      email: env.ADMIN_USERNAME,
      name: "Administrador",
      role: ADMIN_ROLE
    };
    const sessionCookie = await buildSessionCookie(payload, env.SESSION_SECRET);
    return jsonResponse(
      { message: "Login administrativo realizado com sucesso." },
      200,
      { "Set-Cookie": sessionCookie }
    );
  }

  if (url.pathname === "/api/auth/logout" && method === "POST") {
    return jsonResponse(
      { message: "Logout realizado." },
      200,
      { "Set-Cookie": clearSessionCookie() }
    );
  }

  if (url.pathname === "/api/reservas" && method === "GET") {
    const rows = await env.RESERVAS_DB.prepare(
      `SELECT id, descricao, nome, setor, telefone, email_contato, data_reserva, hora_inicio, hora_fim, inicio_iso, fim_iso, owner_google_id, owner_name, owner_email, status, is_imported
       FROM reservations
       WHERE status != 'cancelada'
       ORDER BY inicio_iso ASC`
    ).all();
    return jsonResponse({ reservas: rows.results || [] });
  }

  if (url.pathname === "/api/minhas-reservas" && method === "GET") {
    if (!session || session.role !== USER_ROLE) {
      return jsonError("Usuário não autenticado.", 401);
    }
    const rows = await env.RESERVAS_DB.prepare(
      `SELECT id, descricao, nome, setor, telefone, email_contato, data_reserva, hora_inicio, hora_fim, inicio_iso, fim_iso, status
       FROM reservations
       WHERE owner_google_id = ?
         AND is_imported = 0
       ORDER BY inicio_iso ASC`
    ).bind(session.sub).all();
    return jsonResponse({ reservas: rows.results || [] });
  }

  if (url.pathname === "/api/reservas" && method === "POST") {
    if (!session) {
      return jsonError("Usuário não autenticado.", 401);
    }
    if (session.role !== USER_ROLE) {
      return jsonError("Administrador não pode criar reservas.", 403);
    }

    const body = await parseJsonBody(request);
    const validation = validateReservationInput(body);
    if (!validation.valid) {
      return jsonError(validation.message, 400);
    }
    const normalized = validation.value;

    const conflict = await env.RESERVAS_DB.prepare(
      `SELECT id
       FROM reservations
       WHERE status != 'cancelada'
         AND inicio_iso < ?
         AND fim_iso > ?
       LIMIT 1`
    ).bind(normalized.fimIso, normalized.inicioIso).first();
    if (conflict) {
      return jsonError("Horário já reservado para este período.", 409);
    }

    const id = crypto.randomUUID();
    const nowIso = new Date().toISOString();
    const calendarUrl = buildGoogleCalendarUrl({
      title: normalized.descricao,
      startIso: normalized.inicioIso,
      endIso: normalized.fimIso,
      description: `${normalized.descricao}\nReservado por: ${session.name} (${session.email})\nSetor: ${normalized.setor}`,
      location: normalized.local
    });

    await env.RESERVAS_DB.prepare(
      `INSERT INTO reservations (
        id, owner_google_id, owner_name, owner_email,
        nome, setor, telefone, email_contato, descricao,
        data_reserva, hora_inicio, hora_fim, inicio_iso, fim_iso,
        status, google_calendar_url, created_at, updated_at, is_imported
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      id,
      session.sub,
      session.name,
      session.email,
      normalized.nome,
      normalized.setor,
      normalized.telefone,
      normalized.emailContato,
      normalized.descricao,
      normalized.dataReserva,
      normalized.horaInicio,
      normalized.horaFim,
      normalized.inicioIso,
      normalized.fimIso,
      "ativa",
      calendarUrl,
      nowIso,
      nowIso,
      0
    ).run();

    return jsonResponse({
      message: "Reserva criada com sucesso.",
      reserva: {
        id,
        ...normalized,
        ownerGoogleId: session.sub,
        ownerName: session.name,
        ownerEmail: session.email,
        status: "ativa"
      },
      googleCalendarUrl: calendarUrl
    }, 201);
  }

  if (url.pathname.startsWith("/api/reservas/") && method === "DELETE") {
    if (!session) {
      return jsonError("Usuário não autenticado.", 401);
    }
    const reservationId = url.pathname.split("/").pop();
    if (!reservationId) {
      return jsonError("ID da reserva inválido.", 400);
    }

    const existing = await env.RESERVAS_DB.prepare(
      `SELECT id, owner_google_id, is_imported FROM reservations WHERE id = ?`
    ).bind(reservationId).first();
    if (!existing) {
      return jsonError("Reserva não encontrada.", 404);
    }

    const isImportedReservation = Boolean(existing.is_imported);
    const canDelete =
      session.role === ADMIN_ROLE ||
      (session.role === USER_ROLE && !isImportedReservation && existing.owner_google_id === session.sub);
    if (!canDelete) {
      return jsonError(
        isImportedReservation
          ? "Reservas importadas só podem ser alteradas ou excluídas por um administrador."
          : "Acesso não autorizado para excluir esta reserva.",
        403
      );
    }

    await env.RESERVAS_DB.prepare(
      `DELETE FROM reservations WHERE id = ?`
    ).bind(reservationId).run();
    return jsonResponse({ message: "Reserva excluída com sucesso." });
  }

  if (url.pathname === "/api/admin/reservas" && method === "GET") {
    if (!session || session.role !== ADMIN_ROLE) {
      return jsonError("Acesso administrativo não autorizado.", 403);
    }
    const rows = await env.RESERVAS_DB.prepare(
      `SELECT id, owner_google_id, owner_name, owner_email, nome, setor, telefone, email_contato, descricao,
              data_reserva, hora_inicio, hora_fim, inicio_iso, fim_iso, status, created_at, updated_at, is_imported
       FROM reservations
       ORDER BY inicio_iso ASC`
    ).all();
    return jsonResponse({ reservas: rows.results || [] });
  }

  if (url.pathname.startsWith("/api/admin/reservas/") && method === "PUT") {
    if (!session || session.role !== ADMIN_ROLE) {
      return jsonError("Acesso administrativo não autorizado.", 403);
    }
    const reservationId = url.pathname.split("/").pop();
    if (!reservationId) {
      return jsonError("ID da reserva inválido.", 400);
    }

    const body = await parseJsonBody(request);
    const validation = validateReservationUpdateInput(body);
    if (!validation.valid) {
      return jsonError(validation.message, 400);
    }
    const normalized = validation.value;

    const conflict = await env.RESERVAS_DB.prepare(
      `SELECT id
       FROM reservations
       WHERE id != ?
         AND status != 'cancelada'
         AND inicio_iso < ?
         AND fim_iso > ?
       LIMIT 1`
    ).bind(reservationId, normalized.fimIso, normalized.inicioIso).first();
    if (conflict) {
      return jsonError("Horário já reservado para este período.", 409);
    }

    const updatedAt = new Date().toISOString();
    await env.RESERVAS_DB.prepare(
      `UPDATE reservations
       SET nome = ?, setor = ?, telefone = ?, email_contato = ?, descricao = ?,
           data_reserva = ?, hora_inicio = ?, hora_fim = ?, inicio_iso = ?, fim_iso = ?,
           status = ?, updated_at = ?
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
      normalized.inicioIso,
      normalized.fimIso,
      normalized.status,
      updatedAt,
      reservationId
    ).run();

    return jsonResponse({ message: "Reserva atualizada com sucesso." });
  }

  if (url.pathname.startsWith("/api/admin/reservas/") && method === "DELETE") {
    if (!session || session.role !== ADMIN_ROLE) {
      return jsonError("Acesso administrativo não autorizado.", 403);
    }
    const reservationId = url.pathname.split("/").pop();
    if (!reservationId) {
      return jsonError("ID da reserva inválido.", 400);
    }

    await env.RESERVAS_DB.prepare("DELETE FROM reservations WHERE id = ?")
      .bind(reservationId)
      .run();
    return jsonResponse({ message: "Reserva excluída com sucesso." });
  }

  if (url.pathname === "/api/admin/reservas" && method === "POST") {
    return jsonError("Administrador não pode criar reservas.", 403);
  }

  return jsonError("Rota não encontrada.", 404);
}

function validateReservationInput(body) {
  const nome = normalizeText(body?.nome);
  const setor = normalizeText(body?.setor);
  const telefone = normalizeText(body?.telefone);
  const emailContato = normalizeText(body?.email);
  const descricao = normalizeText(body?.descricao);
  const dataReserva = normalizeText(body?.dataReserva);
  const horaInicio = normalizeText(body?.horaInicio);
  const horaFim = normalizeText(body?.horaFim);
  const local = normalizeText(body?.local || "");

  if (!nome || !setor || !telefone || !emailContato || !descricao || !dataReserva || !horaInicio || !horaFim) {
    return { valid: false, message: "Dados obrigatórios ausentes para a reserva." };
  }
  if (!isValidEmail(emailContato)) {
    return { valid: false, message: "E-mail da reserva inválido." };
  }
  if (!isValidDate(dataReserva) || !isValidTime(horaInicio) || !isValidTime(horaFim)) {
    return { valid: false, message: "Data ou horário inválido." };
  }

  const dateInfo = buildReservationInterval(dataReserva, horaInicio, horaFim);
  if (!dateInfo.valid) {
    return { valid: false, message: dateInfo.message };
  }

  return {
    valid: true,
    value: {
      nome,
      setor,
      telefone,
      emailContato,
      descricao,
      dataReserva,
      horaInicio,
      horaFim,
      inicioIso: dateInfo.inicioIso,
      fimIso: dateInfo.fimIso,
      local
    }
  };
}

function validateReservationUpdateInput(body) {
  const baseValidation = validateReservationInput({
    ...body,
    email: body?.email_contato || body?.email
  });
  if (!baseValidation.valid) {
    return baseValidation;
  }
  const status = normalizeText(body?.status || "ativa");
  if (!["ativa", "cancelada"].includes(status)) {
    return { valid: false, message: "Status de reserva inválido." };
  }

  return {
    valid: true,
    value: {
      ...baseValidation.value,
      status
    }
  };
}

function buildReservationInterval(dataReserva, horaInicio, horaFim) {
  const date = new Date(`${dataReserva}T00:00:00`);
  if (Number.isNaN(date.getTime())) {
    return { valid: false, message: "Data da reserva inválida." };
  }
  const day = date.getDay();
  if (day === 0 || day === 6) {
    return { valid: false, message: "Só é permitido reservar de segunda a sexta-feira." };
  }

  if (!isWorkingHour(horaInicio) || !isWorkingHour(horaFim)) {
    return { valid: false, message: "Horários permitidos: 08:00 até 17:00, de 30 em 30 minutos." };
  }

  const inicio = new Date(`${dataReserva}T${horaInicio}:00`);
  const fim = new Date(`${dataReserva}T${horaFim}:00`);
  if (Number.isNaN(inicio.getTime()) || Number.isNaN(fim.getTime())) {
    return { valid: false, message: "Horário inválido." };
  }
  if (fim <= inicio) {
    return { valid: false, message: "Hora final deve ser maior que a hora inicial." };
  }

  return {
    valid: true,
    inicioIso: inicio.toISOString(),
    fimIso: fim.toISOString()
  };
}

function normalizeText(value) {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim();
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function isValidDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function isValidTime(value) {
  return /^([01]\d|2[0-3]):(00|30)$/.test(value);
}

function isWorkingHour(hora) {
  if (!isValidTime(hora)) {
    return false;
  }
  const [h, m] = hora.split(":").map(Number);
  if (h < 8 || h > 17) {
    return false;
  }
  if (h === 17 && m !== 0) {
    return false;
  }
  return true;
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
      ...headers
    }
  });
}

function jsonError(message, status) {
  return jsonResponse({ error: message }, status);
}

async function buildSessionCookie(payload, sessionSecret) {
  const exp = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
  const completePayload = { ...payload, exp };
  const encodedPayload = toBase64Url(JSON.stringify(completePayload));
  const signature = await hmacSign(encodedPayload, sessionSecret);
  return `${SESSION_COOKIE}=${encodedPayload}.${signature}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_TTL_SECONDS}`;
}

function clearSessionCookie() {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
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
    .map((v) => v.trim())
    .filter(Boolean)
    .reduce((acc, item) => {
      const idx = item.indexOf("=");
      if (idx <= 0) {
        return acc;
      }
      const key = item.slice(0, idx);
      const value = item.slice(idx + 1);
      acc[key] = value;
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
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
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
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
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
  const response = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`);
  if (!response.ok) {
    return null;
  }
  const data = await response.json();
  if (data.aud !== expectedClientId || data.email_verified !== "true") {
    return null;
  }
  return {
    sub: data.sub,
    email: data.email,
    name: data.name || data.given_name || data.email
  };
}

async function sha256Hex(value) {
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value)
  );
  return toHex(hash);
}

function buildGoogleCalendarUrl({ title, startIso, endIso, description, location }) {
  const start = formatGoogleDate(startIso);
  const end = formatGoogleDate(endIso);
  const params = new URLSearchParams({
    action: "TEMPLATE",
    text: title,
    dates: `${start}/${end}`,
    details: description || "",
    location: location || ""
  });
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

function formatGoogleDate(isoDate) {
  return new Date(isoDate).toISOString().replace(/[-:]/g, "").replace(".000", "");
}

function getClientIp(request) {
  return request.headers.get("CF-Connecting-IP") || "unknown";
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
  const now = Date.now();
  return record.blockedUntil && record.blockedUntil > now;
}

async function registerAdminLoginFailure(request, env) {
  if (!env.ADMIN_LOGIN_KV) {
    return;
  }
  const key = `admin-login:${getClientIp(request)}`;
  const now = Date.now();
  const recordRaw = await env.ADMIN_LOGIN_KV.get(key);
  const record = recordRaw ? JSON.parse(recordRaw) : { count: 0, blockedUntil: 0 };
  record.count += 1;
  if (record.count >= 5) {
    record.blockedUntil = now + 15 * 60 * 1000;
    record.count = 0;
  }
  await env.ADMIN_LOGIN_KV.put(key, JSON.stringify(record), { expirationTtl: 15 * 60 });
}

async function clearAdminRateLimit(request, env) {
  if (!env.ADMIN_LOGIN_KV) {
    return;
  }
  const key = `admin-login:${getClientIp(request)}`;
  await env.ADMIN_LOGIN_KV.delete(key);
}
