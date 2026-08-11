import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);
const fileArg = readOption(args, "--file");
const apply = args.includes("--apply");
const local = args.includes("--local") || !args.includes("--remote");
const dbName = readOption(args, "--db") || "RESERVAS_DB";

if (!fileArg) {
  console.error("Uso: node scripts/import-backup.mjs --file <backup.json> [--apply] [--local|--remote] [--db RESERVAS_DB]");
  process.exit(1);
}

const backupPath = path.resolve(fileArg);
const raw = JSON.parse(fs.readFileSync(backupPath, "utf8"));
const reservations = Array.isArray(raw) ? raw : raw.reservasFuturas;

if (!Array.isArray(reservations)) {
  throw new Error("Arquivo de backup inválido: esperado um array ou um objeto com reservasFuturas.");
}

const summary = {
  totalEncontradas: reservations.length,
  elegiveis: 0,
  inseridas: 0,
  puladasDuplicadas: 0,
  puladasConflito: 0,
  puladasInvalidas: 0
};

const normalized = reservations
  .map(normalizeRecord)
  .filter(Boolean)
  .filter((item) => new Date(item.fimIso).getTime() > Date.now())
  .sort((a, b) => a.inicioIso.localeCompare(b.inicioIso));

const seenIds = new Set();
const accepted = [];
const sqlStatements = [
  "BEGIN TRANSACTION;"
];

for (const item of normalized) {
  summary.elegiveis += 1;
  if (seenIds.has(item.sourceReference)) {
    summary.puladasDuplicadas += 1;
    continue;
  }
  seenIds.add(item.sourceReference);

  const conflict = accepted.find((existing) => overlaps(item.inicioIso, item.fimIso, existing.inicioIso, existing.fimIso));
  if (conflict) {
    summary.puladasConflito += 1;
    continue;
  }

  accepted.push(item);
  summary.inseridas += 1;
  sqlStatements.push(insertSql(item));
}

sqlStatements.push("COMMIT;");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "reserva-auditorio-import-"));
const sqlPath = path.join(tempDir, "import.sql");
fs.writeFileSync(sqlPath, sqlStatements.join("\n"), "utf8");

console.log(JSON.stringify({ summary, sqlPath }, null, 2));

if (apply) {
  const wranglerArgs = ["wrangler", "d1", "execute", dbName];
  if (local) {
    wranglerArgs.push("--local");
  } else {
    wranglerArgs.push("--remote");
  }
  wranglerArgs.push("--file", sqlPath);

  const result = spawnSync("npx", wranglerArgs, { stdio: "inherit" });
  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
}

function normalizeRecord(item) {
  if (!item || typeof item !== "object") {
    return null;
  }

  try {
    const inicioIso = new Date(item.inicio).toISOString();
    const fimIso = new Date(item.fim).toISOString();
    const dataReserva = formatDateInTimezone(inicioIso);
    const horaInicio = formatTimeInTimezone(inicioIso);
    const horaFim = formatTimeInTimezone(fimIso);

    if (!isValidDate(dataReserva) || !isValidTime(horaInicio) || !isValidTime(horaFim)) {
      return null;
    }

    return {
      id: safeText(item.id) || crypto.randomUUID(),
      sourceReference: safeText(item.id) || crypto.randomUUID(),
      ownerGoogleId: safeText(item.usuarioId) || `backup-${safeText(item.id)}`,
      ownerName: safeText(item.nome),
      ownerEmail: safeText(item.email),
      nome: safeText(item.nome),
      setor: safeText(item.setor),
      telefone: safeText(item.telefone),
      emailContato: safeText(item.email),
      descricao: safeText(item.descricao),
      inicioIso,
      fimIso,
      dataReserva,
      horaInicio,
      horaFim,
      createdAt: item.raw?.createTime || item.raw?.updateTime || new Date().toISOString(),
      updatedAt: item.raw?.updateTime || item.raw?.createTime || new Date().toISOString(),
      raw: item.raw || item
    };
  } catch {
    summary.puladasInvalidas += 1;
    return null;
  }
}

function insertSql(item) {
  const columns = [
    "id", "owner_google_id", "owner_name", "owner_email",
    "nome", "setor", "telefone", "email_contato", "descricao",
    "data_reserva", "hora_inicio", "hora_fim", "inicio_iso", "fim_iso",
    "status", "google_calendar_url", "created_at", "updated_at",
    "is_imported", "source_origin", "source_reference", "audit_payload_json",
    "recurrence_pattern", "recurrence_series_id", "recurrence_occurrence",
    "recurrence_until", "recurrence_weekdays_json", "created_by_role", "updated_by_role"
  ];

  const values = [
    item.id,
    item.ownerGoogleId,
    item.ownerName,
    item.ownerEmail,
    item.nome,
    item.setor,
    item.telefone,
    item.emailContato,
    item.descricao,
    item.dataReserva,
    item.horaInicio,
    item.horaFim,
    item.inicioIso,
    item.fimIso,
    "ativa",
    buildGoogleCalendarUrl(item),
    item.createdAt,
    item.updatedAt,
    1,
    "backup-json",
    item.sourceReference,
    JSON.stringify(item.raw),
    "single",
    null,
    0,
    null,
    "[]",
    "admin",
    "admin"
  ];

  return `INSERT INTO reservations (${columns.join(", ")}) VALUES (${values.map(sqlValue).join(", ")});`;
}

function buildGoogleCalendarUrl(item) {
  const params = new URLSearchParams({
    action: "TEMPLATE",
    text: item.descricao,
    dates: `${formatGoogleDate(item.inicioIso)}/${formatGoogleDate(item.fimIso)}`,
    details: `Responsável: ${item.ownerName} (${item.ownerEmail})\nSetor: ${item.setor}\nTelefone: ${item.telefone}`,
    location: "Auditório"
  });
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

function overlaps(startA, endA, startB, endB) {
  return startA < endB && endA > startB;
}

function sqlValue(value) {
  if (value === null || value === undefined) {
    return "NULL";
  }
  if (typeof value === "number") {
    return String(value);
  }
  return `'${String(value).replaceAll("'", "''")}'`;
}

function safeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function isValidDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function isValidTime(value) {
  return /^(0[8-9]|1[0-6]|17):(00|30)$/.test(value);
}

function formatDateInTimezone(iso) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
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
    timeZone: "America/Sao_Paulo",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(new Date(iso));
}

function formatGoogleDate(isoDate) {
  return new Date(isoDate).toISOString().replace(/[-:]/g, "").replace(".000", "");
}

function readOption(argv, name) {
  const fromEquals = argv.find((arg) => arg.startsWith(`${name}=`));
  if (fromEquals) {
    return fromEquals.split("=").slice(1).join("=");
  }
  const index = argv.indexOf(name);
  if (index >= 0 && argv[index + 1] && !argv[index + 1].startsWith("--")) {
    return argv[index + 1];
  }
  return null;
}
