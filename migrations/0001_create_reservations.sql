CREATE TABLE IF NOT EXISTS reservations (
  id TEXT PRIMARY KEY,
  owner_google_id TEXT NOT NULL,
  owner_name TEXT NOT NULL,
  owner_email TEXT NOT NULL,
  nome TEXT NOT NULL,
  setor TEXT NOT NULL,
  telefone TEXT NOT NULL,
  email_contato TEXT NOT NULL,
  descricao TEXT NOT NULL,
  data_reserva TEXT NOT NULL,
  hora_inicio TEXT NOT NULL,
  hora_fim TEXT NOT NULL,
  inicio_iso TEXT NOT NULL,
  fim_iso TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ativa',
  google_calendar_url TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_reservations_interval ON reservations(inicio_iso, fim_iso);
CREATE INDEX IF NOT EXISTS idx_reservations_owner ON reservations(owner_google_id);
