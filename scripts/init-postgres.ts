import { Pool } from "pg";
import dotenv from "dotenv";

dotenv.config({ path: ".env.local" });

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  console.error("Missing DATABASE_URL. Create a Neon Postgres database and set DATABASE_URL first.");
  process.exit(1);
}

const pool = new Pool({
  connectionString: databaseUrl,
  ssl: databaseUrl.includes("localhost") ? false : { rejectUnauthorized: false },
});

await pool.query(`
  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    owner_email TEXT NOT NULL DEFAULT 'local@device',
    title TEXT NOT NULL,
    topic TEXT NOT NULL,
    status TEXT NOT NULL,
    voice_id TEXT NOT NULL,
    voice_name TEXT NOT NULL,
    voice_speed DOUBLE PRECISION NOT NULL,
    output_path TEXT,
    error_message TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS users (
    email TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    picture TEXT,
    provider TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL REFERENCES users(email) ON DELETE CASCADE,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS user_settings (
    email TEXT PRIMARY KEY REFERENCES users(email) ON DELETE CASCADE,
    storage_quota_bytes BIGINT NOT NULL,
    credits INTEGER NOT NULL,
    default_language TEXT NOT NULL,
    default_ratio TEXT NOT NULL,
    default_quality TEXT NOT NULL,
    theme TEXT NOT NULL DEFAULT 'dark',
    ui_scale DOUBLE PRECISION NOT NULL DEFAULT 1,
    storage_mode TEXT NOT NULL DEFAULT 'server',
    save_root TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS render_jobs (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    status TEXT NOT NULL,
    progress INTEGER NOT NULL,
    current_step TEXT NOT NULL,
    output_dir TEXT,
    script_path TEXT,
    video_path TEXT,
    audio_path TEXT,
    error_message TEXT,
    started_at TEXT,
    finished_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS assets (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    file_name TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    file_path TEXT NOT NULL,
    file_size BIGINT NOT NULL,
    duration DOUBLE PRECISION,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS scenes (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    scene_key TEXT NOT NULL,
    scene_order INTEGER NOT NULL,
    scene_type TEXT NOT NULL,
    voice_text TEXT NOT NULL,
    template_id TEXT NOT NULL,
    source_asset_id TEXT,
    source_start DOUBLE PRECISION,
    source_end DOUBLE PRECISION,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_projects_owner_email ON projects(owner_email);
  CREATE INDEX IF NOT EXISTS idx_render_jobs_project_id ON render_jobs(project_id);
  CREATE INDEX IF NOT EXISTS idx_assets_project_id ON assets(project_id);
  CREATE INDEX IF NOT EXISTS idx_scenes_project_id_order ON scenes(project_id, scene_order);
`);

await pool.end();

console.log("Postgres schema is ready.");
